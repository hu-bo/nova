import * as Minio from 'minio';
import type { MinioConfig, ConfigFile } from '@/types/config';

const minioConfig: MinioConfig = {
  endPoint: process.env.MINIO_ENDPOINT || 'minio.8and1.cn',
  port: Number(process.env.MINIO_PORT) || 80,
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || '',
  secretKey: process.env.MINIO_SECRET_KEY || '',
  bucket: process.env.MINIO_BUCKET || 'config',
};

const minioClient = new Minio.Client({
  endPoint: minioConfig.endPoint,
  port: minioConfig.port,
  useSSL: minioConfig.useSSL,
  accessKey: minioConfig.accessKey,
  secretKey: minioConfig.secretKey,
});

const bucket = minioConfig.bucket;

export async function ensureBucket(): Promise<void> {
  const exists = await minioClient.bucketExists(bucket);
  if (!exists) {
    await minioClient.makeBucket(bucket);
  }
}

export async function listFiles(prefix = ''): Promise<ConfigFile[]> {
  const files: ConfigFile[] = [];
  const stream = minioClient.listObjectsV2(bucket, prefix, true);

  return new Promise((resolve, reject) => {
    stream.on('data', (obj) => {
      if (obj.name) {
        files.push({
          key: obj.name,
          name: obj.name.split('/').pop() || obj.name,
          size: obj.size,
          lastModified: obj.lastModified,
          etag: obj.etag,
        });
      }
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(files));
  });
}

export async function getFile(key: string): Promise<string> {
  const stream = await minioClient.getObject(bucket, key);
  const chunks: Uint8Array[] = [];

  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: Uint8Array) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

export async function putFile(key: string, content: string): Promise<void> {
  const buffer = Buffer.from(content, 'utf-8');
  await minioClient.putObject(bucket, key, buffer, buffer.length, {
    'Content-Type': 'text/plain; charset=utf-8',
  });
}

export async function deleteFile(key: string): Promise<void> {
  await minioClient.removeObject(bucket, key);
}

export async function fileExists(key: string): Promise<boolean> {
  try {
    await minioClient.statObject(bucket, key);
    return true;
  } catch {
    return false;
  }
}

export { minioClient, bucket };
