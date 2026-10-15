import crypto from "crypto";
import dynamoose from "dynamoose";
import type { Item } from "dynamoose/dist/Item.js";

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

interface OAuthRow extends Item {
  pk: string;
  payload: string;
  expiresAt: number;
  leaseUntil?: number;
}

export const TTL_ATTRIBUTE = "expiresAt";

const OAuthSchema = new dynamoose.Schema({
  pk: { type: String, hashKey: true },
  payload: String,
  expiresAt: Number,
  leaseUntil: Number,
});

export function configureDynamo(region: string, endpoint?: string) {
  dynamoose.aws.ddb.set(new dynamoose.aws.ddb.DynamoDB({ region, endpoint }));
}

export function oauthModel(prefix: string) {
  return dynamoose.model<OAuthRow>("oauth", OAuthSchema, {
    create: false,
    prefix,
    waitForActive: false,
    throughput: "ON_DEMAND",
  });
}

export function createOAuthStore(options: { model: ReturnType<typeof oauthModel>; encryptionSecret: string }) {
  const { model } = options;
  const key = Buffer.from(crypto.hkdfSync("sha256", options.encryptionSecret, "", "sparrowdesk-mcp oauth store", 32));

  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const keyFor = (kind: Kind, id: string) => `${kind}#${crypto.createHash("sha256").update(id).digest("hex")}`;
  const payloadIs = (version: string) => new dynamoose.Condition("payload").eq(version);

  function seal(pk: string, value: unknown) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(pk));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }

  function read<T>(pk: string, row: OAuthRow | undefined): Stored<T> | null {
    // DynamoDB TTL deletes lazily (often days late), so expiry is enforced here.
    if (!row || typeof row.payload !== "string" || Number(row.expiresAt) <= nowSeconds()) return null;
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
      if (err instanceof Error && err.name === "ConditionalCheckFailedException") return false;
      throw err;
    }
  }

  async function get<K extends Kind>(kind: K, id: string): Promise<Stored<Records[K]> | null> {
    const pk = keyFor(kind, id);
    return read<Records[K]>(pk, await model.get({ pk }, { consistent: true }));
  }

  function remove<K extends Kind>(kind: K, id: string, version: string) {
    return conditional(model.delete({ pk: keyFor(kind, id) }, { condition: payloadIs(version) }));
  }

  return {
    async ready() {
      const ddb = dynamoose.aws.ddb();
      const TableName = model.table().name;
      const { Table } = await ddb.describeTable({ TableName });
      if (Table?.TableStatus !== "ACTIVE") {
        throw new Error(`DynamoDB table ${TableName} is ${Table?.TableStatus ?? "missing"}`);
      }
      const { TimeToLiveDescription: ttl } = await ddb.describeTimeToLive({ TableName });
      return { ttlEnabled: ttl?.TimeToLiveStatus === "ENABLED" && ttl.AttributeName === TTL_ATTRIBUTE };
    },

    async put<K extends Kind>(kind: K, id: string, value: Records[K], ttlSeconds: number) {
      const pk = keyFor(kind, id);
      await model.create({ pk, payload: seal(pk, value), expiresAt: nowSeconds() + ttlSeconds }, { overwrite: true });
    },

    get,

    // The conditional delete lets exactly one concurrent caller consume the record.
    async take<K extends Kind>(kind: K, id: string): Promise<Records[K] | null> {
      const stored = await get(kind, id);
      return stored && (await remove(kind, id, stored.version)) ? stored.value : null;
    },

    claim<K extends Kind>(kind: K, id: string, version: string, leaseSeconds: number) {
      const now = nowSeconds();
      return conditional(model.update(
        { pk: keyFor(kind, id) },
        { $SET: { leaseUntil: now + leaseSeconds } },
        {
          condition: payloadIs(version)
            .and()
            .parenthesis((c) => c.where("leaseUntil").not().exists().or().where("leaseUntil").lt(now)),
        },
      ));
    },

    remove,
  };
}

export type OAuthStore = ReturnType<typeof createOAuthStore>;
