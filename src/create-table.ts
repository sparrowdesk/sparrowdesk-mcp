import { CreateTableCommand, UpdateTimeToLiveCommand, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { createDynamoClient, oauthTableName, TTL_ATTRIBUTE } from "./store.js";

const { DYNAMO_REGION, DYNAMO_PREFIX, DYNAMO_ENDPOINT } = process.env;
if (!DYNAMO_REGION || !DYNAMO_PREFIX) {
  console.error("DYNAMO_REGION and DYNAMO_PREFIX are required");
  process.exit(1);
}

const TableName = oauthTableName(DYNAMO_PREFIX);
const client = createDynamoClient(DYNAMO_REGION, DYNAMO_ENDPOINT);

await client.send(new CreateTableCommand({
  TableName,
  BillingMode: "PAY_PER_REQUEST",
  AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
  KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
}));
await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName });
await client.send(new UpdateTimeToLiveCommand({
  TableName,
  TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true },
}));

console.log(`Created ${TableName} (TTL on ${TTL_ATTRIBUTE})`);
