import dynamoose from "dynamoose";
import { configureDynamo, oauthModel, TTL_ATTRIBUTE } from "./store.js";

const { DYNAMO_REGION, DYNAMO_PREFIX, DYNAMO_ENDPOINT } = process.env;
if (!DYNAMO_REGION || !DYNAMO_PREFIX) {
  console.error("DYNAMO_REGION and DYNAMO_PREFIX are required");
  process.exit(1);
}

configureDynamo(DYNAMO_REGION, DYNAMO_ENDPOINT);
const table = oauthModel(DYNAMO_PREFIX).table();
const ddb = dynamoose.aws.ddb();

await table.create();
for (let attempt = 0; attempt < 60; attempt++) {
  if ((await ddb.describeTable({ TableName: table.name })).Table?.TableStatus === "ACTIVE") break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
await ddb.updateTimeToLive({
  TableName: table.name,
  TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true },
});

console.log(`Created ${table.name} (TTL on ${TTL_ATTRIBUTE})`);
