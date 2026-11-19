import { requireDevice } from '@/lib/server/auth';
import { json, route } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Lets `connector diagnose` confirm that the token is valid. */
export const GET = route(async (req: Request) => {
  const d = await requireDevice(req);
  return json({ deviceId: d.id, name: d.name });
});
