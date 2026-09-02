import { historicalManifestArtifact } from '../../../data/historical-artifacts.mjs';

export async function GET() {
  return new Response(await historicalManifestArtifact(), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
