import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { availabilityHistory, userAvailability, type availabilityStatusEnum } from "@/db/schema/userAvailability";
import { teamChannelId } from "@/lib/realtime/channels";
import { publishToRealtime } from "@/lib/realtime/publish";

export type AvailabilityStatus = (typeof availabilityStatusEnum.enumValues)[number];

export interface UserAvailabilityData {
  userId: string;
  mailboxId: number;
  status: AvailabilityStatus;
  customMessage?: string | null;
  lastActivityAt: Date;
  lastStatusChangeAt: Date;
  autoAwayAt?: Date | null;
  scheduledReturnAt?: Date | null;
  businessHours?: {
    timezone: string;
    schedule: Record<string, { start: string; end: string } | null>;
  } | null;
}

export interface AvailabilityHistoryData {
  userId: string;
  mailboxId: number;
  fromStatus: AvailabilityStatus;
  toStatus: AvailabilityStatus;
  durationSeconds?: number;
  changeReason: "manual" | "auto_activity" | "auto_inactivity" | "business_hours" | "scheduled";
  sessionData?: {
    conversationsHandled?: number;
    messagesReplied?: number;
    averageResponseTime?: number;
  };
}

const AUTO_AWAY_MINUTES = 15;
const AUTO_OFFLINE_MINUTES = 60;

export const getUserAvailability = async (userId: string, mailboxId: number): Promise<UserAvailabilityData | null> => {
  const availability = await db.query.userAvailability.findFirst({
    where: and(eq(userAvailability.userId, userId), eq(userAvailability.mailboxId, mailboxId)),
  });

  return availability
    ? {
        userId: availability.userId,
        mailboxId: availability.mailboxId,
        status: availability.status,
        customMessage: availability.customMessage,
        lastActivityAt: availability.lastActivityAt,
        lastStatusChangeAt: availability.lastStatusChangeAt,
        autoAwayAt: availability.autoAwayAt,
        scheduledReturnAt: availability.scheduledReturnAt,
        businessHours: availability.businessHours,
      }
    : null;
};

export const getAllTeamAvailability = async (mailboxId: number): Promise<UserAvailabilityData[]> => {
  const availabilities = await db.query.userAvailability.findMany({
    where: eq(userAvailability.mailboxId, mailboxId),
    orderBy: [desc(userAvailability.lastActivityAt)],
  });

  return availabilities.map((availability) => ({
    userId: availability.userId,
    mailboxId: availability.mailboxId,
    status: availability.status,
    customMessage: availability.customMessage,
    lastActivityAt: availability.lastActivityAt,
    lastStatusChangeAt: availability.lastStatusChangeAt,
    autoAwayAt: availability.autoAwayAt,
    scheduledReturnAt: availability.scheduledReturnAt,
    businessHours: availability.businessHours,
  }));
};

export const updateUserAvailability = async (
  userId: string,
  mailboxId: number,
  updates: Partial<UserAvailabilityData> & {
    changeReason?: AvailabilityHistoryData["changeReason"];
    sessionData?: AvailabilityHistoryData["sessionData"];
  },
): Promise<UserAvailabilityData> => {
  const current = await getUserAvailability(userId, mailboxId);
  const now = new Date();

  const { changeReason = "manual", sessionData, ...availabilityUpdates } = updates;

  return await db.transaction(async (tx) => {
    let result: UserAvailabilityData;

    if (current) {
      const durationSeconds = Math.floor((now.getTime() - current.lastStatusChangeAt.getTime()) / 1000);

      if (availabilityUpdates.status && availabilityUpdates.status !== current.status) {
        await tx.insert(availabilityHistory).values({
          userId,
          mailboxId,
          fromStatus: current.status,
          toStatus: availabilityUpdates.status,
          durationSeconds,
          changeReason,
          sessionData,
        });
      }

      const [updated] = await tx
        .update(userAvailability)
        .set({
          ...availabilityUpdates,
          lastStatusChangeAt: availabilityUpdates.status ? now : current.lastStatusChangeAt,
          lastActivityAt: now,
        })
        .where(and(eq(userAvailability.userId, userId), eq(userAvailability.mailboxId, mailboxId)))
        .returning();

      if (!updated) {
        throw new Error("Failed to update user availability");
      }

      result = {
        userId: updated.userId,
        mailboxId: updated.mailboxId,
        status: updated.status,
        customMessage: updated.customMessage,
        lastActivityAt: updated.lastActivityAt,
        lastStatusChangeAt: updated.lastStatusChangeAt,
        autoAwayAt: updated.autoAwayAt,
        scheduledReturnAt: updated.scheduledReturnAt,
        businessHours: updated.businessHours,
      };
    } else {
      const [created] = await tx
        .insert(userAvailability)
        .values({
          userId,
          mailboxId,
          status: "online",
          lastActivityAt: now,
          lastStatusChangeAt: now,
          ...availabilityUpdates,
        })
        .returning();

      if (!created) {
        throw new Error("Failed to create user availability");
      }

      result = {
        userId: created.userId,
        mailboxId: created.mailboxId,
        status: created.status,
        customMessage: created.customMessage,
        lastActivityAt: created.lastActivityAt,
        lastStatusChangeAt: created.lastStatusChangeAt,
        autoAwayAt: created.autoAwayAt,
        scheduledReturnAt: created.scheduledReturnAt,
        businessHours: created.businessHours,
      };
    }

    await publishToRealtime({
      channel: teamChannelId(mailboxId),
      event: "availability.updated",
      data: result,
    });

    return result;
  });
};

export const recordUserActivity = async (userId: string, mailboxId: number): Promise<void> => {
  const current = await getUserAvailability(userId, mailboxId);

  if (!current) {
    await updateUserAvailability(userId, mailboxId, {
      status: "online",
      changeReason: "auto_activity",
    });
    return;
  }

  const now = new Date();
  const updates: Partial<UserAvailabilityData> & { changeReason?: AvailabilityHistoryData["changeReason"] } = {
    lastActivityAt: now,
  };

  if (current.status === "offline" || current.status === "away") {
    updates.status = "online";
    updates.changeReason = "auto_activity";
  }

  if (current.autoAwayAt) {
    updates.autoAwayAt = new Date(now.getTime() + AUTO_AWAY_MINUTES * 60 * 1000);
  }

  await updateUserAvailability(userId, mailboxId, updates);
};

export const getAvailabilityAnalytics = async (mailboxId: number, startDate: Date, endDate: Date) => {
  const history = await db.query.availabilityHistory.findMany({
    where: and(
      eq(availabilityHistory.mailboxId, mailboxId),
      gte(availabilityHistory.createdAt, startDate),
      lte(availabilityHistory.createdAt, endDate),
    ),
    orderBy: [desc(availabilityHistory.createdAt)],
  });

  const analytics = {
    totalSessions: history.length,
    averageSessionDuration: 0,
    statusDistribution: {
      online: 0,
      busy: 0,
      away: 0,
      offline: 0,
    },
    productivityMetrics: {
      totalConversationsHandled: 0,
      totalMessagesReplied: 0,
      averageResponseTime: 0,
    },
    timelineData: [] as {
      date: string;
      online: number;
      busy: number;
      away: number;
      offline: number;
    }[],
  };

  let totalDuration = 0;
  let totalConversations = 0;
  let totalMessages = 0;
  let totalResponseTime = 0;
  let responseTimeCount = 0;

  history.forEach((record) => {
    if (record.durationSeconds) {
      totalDuration += Number(record.durationSeconds);
      analytics.statusDistribution[record.fromStatus]++;
    }

    if (record.sessionData) {
      totalConversations += record.sessionData.conversationsHandled || 0;
      totalMessages += record.sessionData.messagesReplied || 0;
      if (record.sessionData.averageResponseTime) {
        totalResponseTime += record.sessionData.averageResponseTime;
        responseTimeCount++;
      }
    }
  });

  analytics.averageSessionDuration = history.length > 0 ? totalDuration / history.length : 0;
  analytics.productivityMetrics = {
    totalConversationsHandled: totalConversations,
    totalMessagesReplied: totalMessages,
    averageResponseTime: responseTimeCount > 0 ? totalResponseTime / responseTimeCount : 0,
  };

  return analytics;
};

export const processScheduledStatusChanges = async (): Promise<void> => {
  const now = new Date();

  const scheduledReturns = await db.query.userAvailability.findMany({
    where: and(lte(userAvailability.scheduledReturnAt, now), eq(userAvailability.status, "away")),
  });

  for (const user of scheduledReturns) {
    await updateUserAvailability(user.userId, user.mailboxId, {
      status: "online",
      scheduledReturnAt: null,
      changeReason: "scheduled",
    });
  }

  const autoAwayUsers = await db.query.userAvailability.findMany({
    where: and(lte(userAvailability.autoAwayAt, now), eq(userAvailability.status, "online")),
  });

  for (const user of autoAwayUsers) {
    await updateUserAvailability(user.userId, user.mailboxId, {
      status: "away",
      autoAwayAt: null,
      changeReason: "auto_inactivity",
    });
  }
};

export const getTeamWorkloadDistribution = async (mailboxId: number) => {
  const availabilities = await getAllTeamAvailability(mailboxId);

  const openConversations = await db.execute(sql`
    SELECT 
      assigned_to_clerk_id as user_id,
      COUNT(*) as conversation_count
    FROM conversations_conversation 
    WHERE mailbox_id = ${mailboxId} 
      AND status = 'open' 
      AND assigned_to_clerk_id IS NOT NULL
    GROUP BY assigned_to_clerk_id
  `);

  const workloadMap = new Map(
    openConversations.rows.map((row) => [row.user_id as string, Number(row.conversation_count)]),
  );

  return availabilities.map((availability) => ({
    ...availability,
    currentWorkload: workloadMap.get(availability.userId) || 0,
    isAvailableForAssignment: ["online", "busy"].includes(availability.status),
  }));
};
