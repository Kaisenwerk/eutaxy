// @eutaxy/aws: the AWS platform (Lambda + SQS + DynamoDB). See README.md.

export { atMostOncePerKey } from "@eutaxy/core";
export {
  type AttemptRecord,
  type DifferentialResult,
  runAwsDifferential,
  type Side,
} from "./differential.ts";
export {
  type KeyDef,
  type KeyType,
  resetTables,
  snapshotTables,
  type TableSpec,
} from "./dynamodb.ts";
export {
  type AwsPlatformOptions,
  createAwsPlatform,
  type LambdaContext,
  type SqsBatchResponse,
  type SqsEvent,
  type SqsHandler,
  type SqsRecord,
} from "./platform.ts";
export {
  type AwsScenarioInput,
  atLeastOncePerMessage,
  defineAwsScenario,
  dynamoRows,
  dynamoTable,
  dynamoWrite,
  type SqsDrive,
  type SqsMessage,
  sqs,
  sqsDelete,
} from "./scenario.ts";
export {
  installSdkProxy,
  normalizeOp,
  originalSend,
  rawSend,
  type SdkProxyOptions,
  summarize,
  tablesOf,
  targetOf,
} from "./sdk.ts";
