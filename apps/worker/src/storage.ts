import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { chunk, type ObjectMeta, type ObjectStore } from "@ma/core";

const DELETE_BATCH = 1000;
const SHA_METADATA = "sha256";

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: Pick<S3Client, "send">,
    private readonly bucket: string,
  ) {}

  static fromEnv(bucket: string, region: string): S3ObjectStore {
    return new S3ObjectStore(new S3Client({ region }), bucket);
  }

  async put(key: string, body: Uint8Array, sha256: string, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
        Metadata: { [SHA_METADATA]: sha256 },
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.Body ? await res.Body.transformToByteArray() : null;
    } catch (err) {
      if (err instanceof NoSuchKey || err instanceof NotFound) return null;
      throw err;
    }
  }

  async head(key: string): Promise<ObjectMeta | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { bytes: res.ContentLength ?? 0, sha256: res.Metadata?.[SHA_METADATA] ?? null };
    } catch (err) {
      if (err instanceof NotFound || err instanceof NoSuchKey) return null;
      throw err;
    }
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (const batch of chunk([...keys], DELETE_BATCH)) {
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }
}
