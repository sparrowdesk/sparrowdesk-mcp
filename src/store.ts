import crypto from "crypto";
import {
  ConditionalCheckFailedException,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

export interface RegisteredClient {
  redirectUris: string[];
}
export interface PendingAuth {
  clientRedirectUri: string;
  clientState: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scope?: string;
}
export interface PendingCode {
  token: string;
  refreshToken: string;
  expiresIn: number;
  clientRedirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}
export interface TokenSession {
  sdToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
}

interface Records {
  client: RegisteredClient;
  auth: PendingAuth;
  code: PendingCode;
  session: TokenSession;
}
type Kind = keyof Records;

export interface Stored<T> {
  value: T;
  version: string;
}

export const TTL_ATTRIBUTE = "expiresAt";

export function oauthTableName(prefix: string) {
  return `${prefix}oauth`;
}

export function createDynamoClient(region: string, endpoint?: string) {
  return new DynamoDBClient({ region, endpoint });
}

export function createOAuthStore(options: {
  client: DynamoDBClient;
  tableName: string;
  encryptionSecret: string;
}) {
  const { client, tableName: TableName } = options;
  const db = DynamoDBDocumentClient.from(client);
  const key = Buffer.from(crypto.hkdfSync("sha256", options.encryptionSecret, "", "sparrowdesk-mcp oauth store", 32));

  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const keyFor = (kind: Kind, id: string) => `${kind}#${crypto.createHash("sha256").update(id).digest("hex")}`;

  function seal(pk: string, value: unknown) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(pk));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }

  function read<T>(pk: string, row: Record<string, unknown> | undefined): Stored<T> | null {
    // DynamoDB TTL deletes lazily (often days late), so expiry is enforced here.
    if (!row || typeof row.payload !== "string" || Number(row[TTL_ATTRIBUTE]) <= nowSeconds()) return null;
    const raw = Buffer.from(row.payload, "base64");
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(pk));
      decipher.setAuthTag(raw.subarray(12, 28));
      const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
      return { value: JSON.parse(json) as T, version: row.payload };
    } catch {
      // Sealed under a previous SPARROWDESK_CLIENT_SECRET, whose rotation revoked these tokens upstream anyway.
      return null;
    }
  }

  async function conditional(write: Promise<unknown>) {
    try {
      await write;
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  return {
    async ready() {
      const { Table } = await client.send(new DescribeTableCommand({ TableName }));
      if (Table?.TableStatus !== "ACTIVE") {
        throw new Error(`DynamoDB table ${TableName} is ${Table?.TableStatus ?? "missing"}`);
      }
      const { TimeToLiveDescription: ttl } = await client.send(new DescribeTimeToLiveCommand({ TableName }));
      return { ttlEnabled: ttl?.TimeToLiveStatus === "ENABLED" && ttl.AttributeName === TTL_ATTRIBUTE };
    },

    async put<K extends Kind>(kind: K, id: string, value: Records[K], ttlSeconds: number) {
      const pk = keyFor(kind, id);
      await db.send(new PutCommand({
        TableName,
        Item: { pk, payload: seal(pk, value), [TTL_ATTRIBUTE]: nowSeconds() + ttlSeconds },
      }));
    },

    async get<K extends Kind>(kind: K, id: string): Promise<Stored<Records[K]> | null> {
      const pk = keyFor(kind, id);
      const { Item } = await db.send(new GetCommand({ TableName, Key: { pk }, ConsistentRead: true }));
      return read<Records[K]>(pk, Item);
    },

    async take<K extends Kind>(kind: K, id: string): Promise<Records[K] | null> {
      const pk = keyFor(kind, id);
      const { Attributes } = await db.send(new DeleteCommand({ TableName, Key: { pk }, ReturnValues: "ALL_OLD" }));
      return read<Records[K]>(pk, Attributes)?.value ?? null;
    },

    claim<K extends Kind>(kind: K, id: string, version: string, leaseSeconds: number) {
      const now = nowSeconds();
      return conditional(db.send(new UpdateCommand({
        TableName,
        Key: { pk: keyFor(kind, id) },
        UpdateExpression: "SET leaseUntil = :until",
        ConditionExpression: "payload = :version AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)",
        ExpressionAttributeValues: { ":version": version, ":until": now + leaseSeconds, ":now": now },
      })));
    },

    remove<K extends Kind>(kind: K, id: string, version: string) {
      return conditional(db.send(new DeleteCommand({
        TableName,
        Key: { pk: keyFor(kind, id) },
        ConditionExpression: "payload = :version",
        ExpressionAttributeValues: { ":version": version },
      })));
    },
  };
}

export type OAuthStore = ReturnType<typeof createOAuthStore>;
