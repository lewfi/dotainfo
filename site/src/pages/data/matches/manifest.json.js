import { historicalManifest, serializeArtifact } from '../../../data/historical-artifacts.mjs';

export async function GET() {
  return new Response(serializeArtifact(await historicalManifest()), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
