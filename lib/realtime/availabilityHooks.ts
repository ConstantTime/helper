import { useState } from "react";
import { useSession } from "@/components/useSession";
import type { UserAvailabilityData } from "@/lib/data/userAvailability";
import { teamChannelId } from "@/lib/realtime/channels";
import { useRealtimeEvent } from "@/lib/realtime/hooks";

export const useTeamAvailability = (mailboxId: number) => {
  const [teamAvailability, setTeamAvailability] = useState<Record<string, UserAvailabilityData>>({});

  useRealtimeEvent<UserAvailabilityData>(teamChannelId(mailboxId), "availability.updated", ({ data }) => {
    setTeamAvailability((prev) => ({
      ...prev,
      [data.userId]: data,
    }));
  });

  return { teamAvailability };
};

export const useUserAvailabilityStatus = (mailboxId: number) => {
  const { user } = useSession() ?? {};
  const [status, setStatus] = useState<UserAvailabilityData["status"] | null>(null);
  const [customMessage, setCustomMessage] = useState<string | null>(null);
  const [lastUpdateTime, setLastUpdateTime] = useState<number>(0);

  useRealtimeEvent<UserAvailabilityData>(teamChannelId(mailboxId), "availability.updated", ({ data }) => {
    if (data.userId === user?.id) {
      const updateTime = data.lastStatusChangeAt ? new Date(data.lastStatusChangeAt).getTime() : Date.now();

      if (updateTime > lastUpdateTime) {
        setStatus(data.status);
        setCustomMessage(data.customMessage || null);
        setLastUpdateTime(updateTime);
      }
    }
  });

  return { status, customMessage, lastUpdateTime };
};

export const getStatusColor = (status: UserAvailabilityData["status"]): string => {
  switch (status) {
    case "online":
      return "bg-green-500";
    case "busy":
      return "bg-yellow-500";
    case "away":
      return "bg-orange-500";
    case "offline":
      return "bg-gray-400";
    default:
      return "bg-gray-400";
  }
};

export const getStatusLabel = (status: UserAvailabilityData["status"]): string => {
  switch (status) {
    case "online":
      return "Online";
    case "busy":
      return "Busy";
    case "away":
      return "Away";
    case "offline":
      return "Offline";
    default:
      return "Unknown";
  }
};
