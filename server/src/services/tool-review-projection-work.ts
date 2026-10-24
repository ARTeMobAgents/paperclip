import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { toolReviewProjectionService } from "./tool-review-projection.js";

export function registerToolReviewProjectionWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof toolReviewProjectionService>,
  canRun: () => boolean,
) {
  let next: number | null = null;
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.toolReviewProjection, {
    retryMs: 30_000, canRun,
    run: async () => {
      const result = await service.sweep();
      next = result.retry ? Date.now() + 30_000 : null;
    },
    next: async () => next,
  });
}
