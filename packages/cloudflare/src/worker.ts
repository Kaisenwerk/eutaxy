/** The Worker's default export, as far as the platform drives it. */
export interface WorkerHandler {
  queue?(batch: MessageBatch<unknown>, env: unknown, ctx: ExecutionContext): void | Promise<void>;
  fetch?(request: Request, env: unknown, ctx: ExecutionContext): Response | Promise<Response>;
  scheduled?(
    controller: ScheduledController,
    env: unknown,
    ctx: ExecutionContext,
  ): void | Promise<void>;
}
