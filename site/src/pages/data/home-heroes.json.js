import { homeHeroArtifact } from '../../data/home-artifacts.mjs';

export async function GET() {
  return new Response(await homeHeroArtifact(), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
