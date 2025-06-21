import {
  getAllTeamAvailability,
  getAvailabilityAnalytics,
  getTeamWorkloadDistribution,
  getUserAvailability,
  recordUserActivity,
  updateUserAvailability,
} from "@/lib/data/userAvailability";
import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { z } from "zod";
import { mailboxProcedure } from "./procedure";

export const availabilityRouter = {
  updateStatus: mailboxProcedure
    .input(
      z.object({
        status: z.enum(["online", "busy", "away", "offline"]),
        customMessage: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await updateUserAvailability(ctx.user.id, ctx.mailbox.id, {
          status: input.status,
          customMessage: input.customMessage,
          changeReason: "manual",
        });
        return result;
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update availability status",
        });
      }
    }),

  getMyStatus: mailboxProcedure.query(async ({ ctx }) => {
    return await getUserAvailability(ctx.user.id, ctx.mailbox.id);
  }),

  getTeamStatus: mailboxProcedure.query(async ({ ctx }) => {
    return await getAllTeamAvailability(ctx.mailbox.id);
  }),

  recordActivity: mailboxProcedure.mutation(async ({ ctx }) => {
    await recordUserActivity(ctx.user.id, ctx.mailbox.id);
    return { success: true };
  }),

  getWorkloadDistribution: mailboxProcedure.query(async ({ ctx }) => {
    return await getTeamWorkloadDistribution(ctx.mailbox.id);
  }),

  getAnalytics: mailboxProcedure
    .input(
      z.object({
        startDate: z.date(),
        endDate: z.date(),
      }),
    )
    .query(async ({ ctx, input }) => {
      return await getAvailabilityAnalytics(ctx.mailbox.id, input.startDate, input.endDate);
    }),

  setBusinessHours: mailboxProcedure
    .input(
      z.object({
        timezone: z.string(),
        schedule: z.record(
          z.string(),
          z
            .object({
              start: z.string(),
              end: z.string(),
            })
            .nullable(),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await updateUserAvailability(ctx.user.id, ctx.mailbox.id, {
          businessHours: {
            timezone: input.timezone,
            schedule: input.schedule,
          },
          changeReason: "manual",
        });
        return result;
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update business hours",
        });
      }
    }),

  setScheduledReturn: mailboxProcedure
    .input(
      z.object({
        returnAt: z.date(),
        message: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await updateUserAvailability(ctx.user.id, ctx.mailbox.id, {
          status: "away",
          scheduledReturnAt: input.returnAt,
          customMessage: input.message || null,
          changeReason: "manual",
        });
        return result;
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to set scheduled return",
        });
      }
    }),
} satisfies TRPCRouterRecord;
