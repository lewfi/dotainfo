import { searchIndex } from '../../data/search.mjs';

export const prerender = true;

export async function GET() {
  return new Response(JSON.stringify(await searchIndex()), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
