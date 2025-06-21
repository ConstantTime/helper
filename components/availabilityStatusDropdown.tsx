import { Check, ChevronDown, Circle, Clock, Minus, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { UserAvailabilityData } from "@/lib/data/userAvailability";
import { getStatusColor, getStatusLabel } from "@/lib/realtime/availabilityHooks";
import { api } from "@/trpc/react";

interface AvailabilityStatusDropdownProps {
  mailboxSlug: string;
  currentStatus?: UserAvailabilityData["status"];
  customMessage?: string | null;
  className?: string;
}

const statusOptions = [
  { value: "online" as const, label: "Online", icon: Circle, description: "Available for new assignments" },
  { value: "busy" as const, label: "Busy", icon: Minus, description: "Working, limited assignments" },
  { value: "away" as const, label: "Away", icon: Clock, description: "Not available for assignments" },
] as const;

export function AvailabilityStatusDropdown({
  mailboxSlug,
  currentStatus = "offline",
  customMessage,
  className,
}: AvailabilityStatusDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [messageInput, setMessageInput] = useState(customMessage || "");
  const [optimisticStatus, setOptimisticStatus] = useState<UserAvailabilityData["status"] | null>(null);

  const utils = api.useUtils();

  useEffect(() => {
    setMessageInput(customMessage || "");
  }, [customMessage]);

  const { mutate: updateStatus, isPending } = api.mailbox.availability.updateStatus.useMutation({
    onMutate: ({ status }) => {
      setOptimisticStatus(status);
    },
    onSuccess: () => {
      setIsOpen(false);
      setTimeout(() => {
        setOptimisticStatus(null);
      }, 1000);
      utils.mailbox.availability.getMyStatus.invalidate({ mailboxSlug });
    },
    onError: () => {
      setOptimisticStatus(null);
    },
  });

  const handleStatusChange = (status: UserAvailabilityData["status"], message?: string) => {
    updateStatus({
      mailboxSlug,
      status,
      customMessage: message || null,
    });
  };

  const displayStatus = optimisticStatus || currentStatus;
  const currentStatusOption = statusOptions.find((option) => option.value === displayStatus);
  const StatusIcon = currentStatusOption?.icon || Circle;

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={`flex items-center gap-2 ${className}`} disabled={isPending}>
          <div className={`w-2 h-2 rounded-full ${getStatusColor(displayStatus)}`} />
          <span className="hidden sm:inline">{getStatusLabel(displayStatus)}</span>
          <ChevronDown className="w-3 h-3" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Set your availability</DropdownMenuLabel>
        <DropdownMenuSeparator />

        {statusOptions.map((option) => {
          const Icon = option.icon;
          const isSelected = displayStatus === option.value;

          return (
            <DropdownMenuItem
              key={option.value}
              className="flex items-center gap-3 p-3 cursor-pointer"
              onClick={() => handleStatusChange(option.value)}
            >
              <div className={`w-3 h-3 rounded-full ${getStatusColor(option.value)}`} />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{option.label}</span>
                  {isSelected && <Check className="w-4 h-4 text-green-600" />}
                </div>
                <p className="text-xs text-muted-foreground">{option.description}</p>
              </div>
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator />

        <div className="p-3">
          <Label htmlFor="status-message" className="text-xs font-medium">
            Status message (optional)
          </Label>
          <div className="flex gap-2 mt-1">
            <Input
              id="status-message"
              placeholder="What are you working on?"
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              className="text-xs"
            />
            <Button size="sm" onClick={() => handleStatusChange(displayStatus, messageInput)} disabled={isPending}>
              Set
            </Button>
          </div>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuItem className="text-xs text-muted-foreground">
          <Users className="w-3 h-3 mr-2" />
          Team can see your status
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
