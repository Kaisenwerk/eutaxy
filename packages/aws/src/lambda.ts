/** The event and context Lambda hands an SQS-triggered function, built the same way on both sides. */

import type { EventRef } from "@eutaxy/core";

export interface SqsRecord {
  readonly messageId: string;
  readonly receiptHandle: string;
  readonly body: string;
  readonly attributes: {
    readonly ApproximateReceiveCount: string;
    readonly SentTimestamp: string;
    readonly SenderId: string;
    readonly ApproximateFirstReceiveTimestamp: string;
  };
  readonly messageAttributes: Record<string, never>;
  readonly md5OfBody: string;
  readonly eventSource: "aws:sqs";
  readonly eventSourceARN: string;
  readonly awsRegion: string;
}

export interface SqsEvent {
  readonly Records: readonly SqsRecord[];
}

export interface LambdaContext {
  readonly awsRequestId: string;
  readonly functionName: string;
  readonly functionVersion: string;
  readonly invokedFunctionArn: string;
  readonly memoryLimitInMB: string;
  readonly logGroupName: string;
  readonly logStreamName: string;
  callbackWaitsForEmptyEventLoop: boolean;
  getRemainingTimeInMillis(): number;
}

export interface SqsBatchResponse {
  readonly batchItemFailures?: readonly { readonly itemIdentifier: string }[];
}

export type SqsHandler = (
  event: SqsEvent,
  context: LambdaContext,
  // biome-ignore lint/suspicious/noConfusingVoidType: a Lambda handler may return nothing at all
) => Promise<void | SqsBatchResponse> | void | SqsBatchResponse;

/**
 * Whether the message stays on the queue after a completed invocation.
 * AWS, "Implementing partial batch responses" (services-sqs-errorhandling):
 * an `itemIdentifier` that is empty, null or not in the batch makes Lambda
 * treat the whole batch as failed.
 */
export function batchFailed(
  response: SqsBatchResponse | undefined,
  messageId: string,
  delivered: readonly string[],
): boolean {
  const failures = response?.batchItemFailures ?? [];
  return failures.some(
    (f) =>
      !f.itemIdentifier || !delivered.includes(f.itemIdentifier) || f.itemIdentifier === messageId,
  );
}

export interface InvocationShape {
  readonly queue: string;
  readonly region: string;
  readonly functionName: string;
}

/** The record and context for one delivery; `now` is the (virtual) clock at delivery. */
export function sqsInvocation(
  event: EventRef,
  shape: InvocationShape,
  now: number,
): { readonly record: SqsRecord; readonly context: LambdaContext } {
  const record: SqsRecord = {
    messageId: event.id,
    receiptHandle: `${event.id}#${event.attempt}`,
    body: JSON.stringify(event.data),
    attributes: {
      ApproximateReceiveCount: String(event.attempt),
      SentTimestamp: String(now),
      SenderId: "local",
      ApproximateFirstReceiveTimestamp: String(now),
    },
    messageAttributes: {},
    md5OfBody: "",
    eventSource: "aws:sqs",
    eventSourceARN: `arn:aws:sqs:${shape.region}:000000000000:${shape.queue}`,
    awsRegion: shape.region,
  };
  const context: LambdaContext = {
    awsRequestId: crypto.randomUUID(),
    functionName: shape.functionName,
    functionVersion: "$LATEST",
    invokedFunctionArn: `arn:aws:lambda:${shape.region}:000000000000:function:${shape.functionName}`,
    memoryLimitInMB: "128",
    logGroupName: `/aws/lambda/${shape.functionName}`,
    logStreamName: "local",
    callbackWaitsForEmptyEventLoop: true,
    getRemainingTimeInMillis: () => 60_000 - (Date.now() - now),
  };
  return { record, context };
}
