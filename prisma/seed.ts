import { PrismaClient } from '@prisma/client';
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { hashPassword, directKey } from '../src/server/core';
import { readConfig } from '../src/server/config';
async function seed() {
  const config = readConfig();
  const db = new PrismaClient();
  const s3 = new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: config.S3_ACCESS_KEY && config.S3_SECRET_KEY ? { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY } : undefined });
  try {
    if (config.UPLOADS_ENABLED) {
      try { await s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET })); }
      catch { await s3.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET })); }
    }
    const passwordHash = await hashPassword('DemoPassword123!');
    const users = await Promise.all(['Ada', 'Bora', 'Cem'].map((name, i) => db.user.upsert({ where: { email: `${name.toLowerCase()}@demo.local` }, update: {},
      create: { id: `00000000-0000-4000-8000-00000000000${i + 1}`, email: `${name.toLowerCase()}@demo.local`, name, passwordHash } })));
    const rooms = [
      { id: '10000000-0000-4000-8000-000000000001', kind: 'direct', directKey: directKey(users[0].id, users[1].id), name: null, members: users.slice(0, 2) },
      { id: '10000000-0000-4000-8000-000000000002', kind: 'group', directKey: null, name: 'Demo group', members: users }
    ];
    for (const room of rooms) {
      await db.conversation.upsert({ where: { id: room.id }, update: {}, create: { id: room.id, kind: room.kind, name: room.name, directKey: room.directKey,
        members: { create: room.members.map((u, i) => ({ userId: u.id, role: i === 0 ? 'owner' : 'member' })) } } });
      await db.message.upsert({ where: { senderId_clientId: { senderId: users[0].id, clientId: room.id } }, update: {},
        create: { conversationId: room.id, senderId: users[0].id, clientId: room.id, body: 'This is demo data. Open another browser session to try realtime messaging.' } });
    }
    console.log('Seed complete: ada@demo.local, bora@demo.local, cem@demo.local / DemoPassword123!');
  } finally { await db.$disconnect(); s3.destroy(); }
}
void seed().catch(() => { console.error('Seed failed; check database and storage configuration.'); process.exitCode = 1; });
