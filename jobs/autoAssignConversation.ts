import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { conversations } from "@/db/schema/conversations";
import { runAIObjectQuery } from "@/lib/ai";
import { cacheFor } from "@/lib/cache";
import { Conversation, updateConversation } from "@/lib/data/conversation";
import { getMailboxById, Mailbox } from "@/lib/data/mailbox";
import { getUsersWithMailboxAccess, UserRoles, type UserWithMailboxAccessData } from "@/lib/data/user";
import {
  getTeamWorkloadDistribution,
  recordUserActivity,
  type UserAvailabilityData,
} from "@/lib/data/userAvailability";
import { assertDefinedOrRaiseNonRetriableError } from "./utils";

const CACHE_ROUND_ROBIN_KEY_PREFIX = "auto-assign-availability-queue";

interface AvailableTeamMember extends UserWithMailboxAccessData {
  availability: {
    status: UserAvailabilityData["status"];
    currentWorkload: number;
    isAvailableForAssignment: boolean;
    customMessage?: string | null;
  };
}

const WORKLOAD_THRESHOLDS = {
  online: 8,
  busy: 3,
  away: 0,
  offline: 0,
} as const;

const PRIORITY_SCORES = {
  online: 100,
  busy: 50,
  away: 0,
  offline: 0,
} as const;

const getAvailableTeamMembers = async (
  teamMembers: UserWithMailboxAccessData[],
  mailboxId: number,
): Promise<AvailableTeamMember[]> => {
  const workloadDistribution = await getTeamWorkloadDistribution(mailboxId);
  const workloadMap = new Map(workloadDistribution.map((w) => [w.userId, w]));

  return teamMembers
    .map((member) => {
      const workload = workloadMap.get(member.id);
      return {
        ...member,
        availability: {
          status: workload?.status || "offline",
          currentWorkload: workload?.currentWorkload || 0,
          isAvailableForAssignment: workload?.isAvailableForAssignment || false,
          customMessage: workload?.customMessage,
        },
      };
    })
    .filter((member) => member.availability.isAvailableForAssignment);
};

const getCoreTeamMembers = (teamMembers: UserWithMailboxAccessData[]): UserWithMailboxAccessData[] => {
  return teamMembers.filter((member) => member.role === UserRoles.CORE);
};

const getExpertiseMatchingMembers = async (
  availableMembers: AvailableTeamMember[],
  conversationContent: string,
  mailbox: Mailbox,
) => {
  if (!conversationContent || availableMembers.length === 0) {
    return { members: [], aiResult: null };
  }

  const membersWithKeywords = availableMembers.filter(
    (member) => (member.role === UserRoles.NON_CORE || member.role === UserRoles.CORE) && member.keywords.length > 0,
  );

  if (membersWithKeywords.length === 0) {
    return { members: [], aiResult: null };
  }

  const memberKeywords = membersWithKeywords.reduce<Record<string, string[]>>((acc, member) => {
    acc[member.id] = member.keywords;
    return acc;
  }, {});

  const result = await runAIObjectQuery({
    mailbox,
    queryType: "conversation_resolution",
    schema: z.object({
      matches: z.record(z.string(), z.boolean()),
      reasoning: z.string(),
      confidenceScore: z.number().optional(),
      urgencyLevel: z.enum(["low", "medium", "high"]).optional(),
    }),
    system: `You are an Intelligent Support Routing System that considers both expertise and team availability.

Your task is to analyze conversations and match them to available team members based on:
1. Expertise alignment with keywords
2. Current availability status (online > busy > away)
3. Current workload (prefer less loaded members)
4. Conversation urgency and complexity

Available team members and their current status:
${membersWithKeywords
  .map(
    (m) =>
      `${m.id}: ${m.availability.status} (${m.availability.currentWorkload} conversations) - Keywords: ${m.keywords.join(", ")}`,
  )
  .join("\n")}

Consider:
- ONLINE members should be prioritized for all conversations
- BUSY members should only get urgent/specialized conversations
- Match expertise keywords with conversation content
- Factor in current workload for fair distribution
- Consider conversation complexity and member experience level`,
    messages: [
      {
        role: "user",
        content: `CUSTOMER CONVERSATION: "${conversationContent}"

AVAILABLE TEAM MEMBERS:
${Object.entries(memberKeywords)
  .map(([id, keywords]) => {
    const member = membersWithKeywords.find((m) => m.id === id);
    return `Team Member ID: ${id}
Status: ${member?.availability.status} (${member?.availability.currentWorkload} active conversations)
Expertise Keywords: ${keywords.join(", ")}
Role: ${member?.role}`;
  })
  .join("\n\n")}

TASK:
1. Analyze the conversation content and determine expertise requirements
2. Match available team members based on keywords AND current availability
3. Consider workload distribution - don't overload busy members unless they're the only expert
4. Assess conversation urgency level

Return:
- "matches": Team member IDs that can handle this conversation
- "reasoning": Explain your matching and availability considerations  
- "confidenceScore": 0-1 confidence in the match
- "urgencyLevel": low/medium/high based on conversation content`,
      },
    ],
    temperature: 0.1,
    functionId: "auto-assign-availability-keyword-matching",
  });

  return {
    members: membersWithKeywords.filter((member) => result.matches[member.id]),
    aiResult: result,
  };
};

const calculateMemberScore = (member: AvailableTeamMember, hasExpertiseMatch: boolean): number => {
  const baseScore = PRIORITY_SCORES[member.availability.status];
  const workloadPenalty = Math.min(member.availability.currentWorkload * 5, 50);
  const expertiseBonus = hasExpertiseMatch ? 25 : 0;
  const roleBonus = member.role === UserRoles.CORE ? 10 : 0;

  return Math.max(0, baseScore - workloadPenalty + expertiseBonus + roleBonus);
};

const selectBestMember = async (
  availableMembers: AvailableTeamMember[],
  expertiseMatches: AvailableTeamMember[],
  mailboxId: number,
): Promise<AvailableTeamMember | null> => {
  if (availableMembers.length === 0) return null;

  const membersWithScores = availableMembers.map((member) => ({
    member,
    score: calculateMemberScore(member, expertiseMatches.includes(member)),
    hasExpertise: expertiseMatches.includes(member),
  }));

  membersWithScores.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.member.availability.currentWorkload !== b.member.availability.currentWorkload) {
      return a.member.availability.currentWorkload - b.member.availability.currentWorkload;
    }
    return 0;
  });

  const topCandidates = membersWithScores.filter((m) => m.score === membersWithScores[0]?.score);

  if (topCandidates.length === 1) {
    return topCandidates[0]!.member;
  }

  const cache = cacheFor<number>(`${CACHE_ROUND_ROBIN_KEY_PREFIX}:${mailboxId}`);
  const lastAssignedIndex = (await cache.get()) ?? 0;
  const nextIndex = (lastAssignedIndex + 1) % topCandidates.length;
  await cache.set(nextIndex);

  return topCandidates[nextIndex]?.member || null;
};

const canHandleWorkload = (member: AvailableTeamMember): boolean => {
  const threshold = WORKLOAD_THRESHOLDS[member.availability.status];
  return member.availability.currentWorkload < threshold;
};

const getNextCoreTeamMemberInRotation = async (
  coreTeamMembers: UserWithMailboxAccessData[],
  mailboxId: number,
): Promise<UserWithMailboxAccessData | null> => {
  if (coreTeamMembers.length === 0) return null;

  const cache = cacheFor<number>(`${CACHE_ROUND_ROBIN_KEY_PREFIX}:${mailboxId}`);

  const lastAssignedIndex = (await cache.get()) ?? 0;
  const nextIndex = (lastAssignedIndex + 1) % coreTeamMembers.length;

  await cache.set(nextIndex);

  return coreTeamMembers[nextIndex] ?? null;
};

const getConversationContent = (conversationData: {
  messages?: {
    role: string;
    cleanedUpText?: string | null;
  }[];
  subject?: string | null;
}): string => {
  if (!conversationData?.messages || conversationData.messages.length === 0) {
    return conversationData.subject || "";
  }

  const userMessages = conversationData.messages
    .filter((msg) => msg.role === "user")
    .map((msg) => msg.cleanedUpText || "")
    .filter(Boolean);

  const contentParts = [];
  if (conversationData.subject) {
    contentParts.push(conversationData.subject);
  }
  contentParts.push(...userMessages);

  return contentParts.join(" ");
};

const getNextTeamMember = async (
  teamMembers: UserWithMailboxAccessData[],
  conversation: Conversation,
  mailbox: Mailbox,
) => {
  const availableMembers = await getAvailableTeamMembers(teamMembers, mailbox.id);

  if (availableMembers.length === 0) {
    return { member: null, aiResult: null, error: "No team members available for assignment" };
  }

  const workloadCapableMembers = availableMembers.filter(canHandleWorkload);
  const membersToConsider = workloadCapableMembers.length > 0 ? workloadCapableMembers : availableMembers;

  const conversationContent = getConversationContent(conversation);
  const { members: expertiseMatches, aiResult } = await getExpertiseMatchingMembers(
    membersToConsider,
    conversationContent,
    mailbox,
  );

  const selectedMember = await selectBestMember(membersToConsider, expertiseMatches, mailbox.id);

  return {
    member: selectedMember,
    aiResult,
    availabilityMetrics: {
      totalAvailable: availableMembers.length,
      onlineMembers: availableMembers.filter((m) => m.availability.status === "online").length,
      busyMembers: availableMembers.filter((m) => m.availability.status === "busy").length,
      averageWorkload:
        availableMembers.reduce((sum, m) => sum + m.availability.currentWorkload, 0) / availableMembers.length,
    },
  };
};

export const autoAssignConversation = async ({ conversationId }: { conversationId: number }) => {
  const conversation = assertDefinedOrRaiseNonRetriableError(
    await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      with: {
        messages: {
          columns: {
            id: true,
            role: true,
            cleanedUpText: true,
          },
        },
      },
    }),
  );

  if (conversation.assignedToId) return { message: "Skipped: already assigned" };
  if (conversation.mergedIntoId) return { message: "Skipped: conversation is merged" };

  const mailbox = assertDefinedOrRaiseNonRetriableError(await getMailboxById(conversation.mailboxId));
  const teamMembers = assertDefinedOrRaiseNonRetriableError(await getUsersWithMailboxAccess(mailbox.id));

  const activeTeamMembers = teamMembers.filter(
    (member) => member.role === UserRoles.CORE || member.role === UserRoles.NON_CORE,
  );

  if (activeTeamMembers.length === 0) {
    return { message: "Skipped: no active team members available for assignment" };
  }

  const {
    member: nextTeamMember,
    aiResult,
    error,
    availabilityMetrics,
  } = await getNextTeamMember(activeTeamMembers, conversation, mailbox);

  if (!nextTeamMember) {
    return {
      message: "Skipped: could not find suitable team member for assignment",
      details: error || "No available members with capacity or expertise match",
      availabilityMetrics,
    };
  }

  await recordUserActivity(nextTeamMember.id, mailbox.id);

  await updateConversation(conversation.id, {
    set: { assignedToId: nextTeamMember.id },
    message:
      aiResult?.reasoning ||
      `Assigned based on availability (${nextTeamMember.availability.status}) and workload (${nextTeamMember.availability.currentWorkload} conversations)`,
  });

  return {
    message: `Assigned conversation ${conversation.id} to ${nextTeamMember.displayName} (${nextTeamMember.id})`,
    assigneeRole: nextTeamMember.role,
    assigneeId: nextTeamMember.id,
    assigneeStatus: nextTeamMember.availability.status,
    assigneeWorkload: nextTeamMember.availability.currentWorkload,
    aiResult,
    availabilityMetrics,
  };
};
