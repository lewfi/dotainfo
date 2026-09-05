import {
  homeBuildContext,
  homePlayerDayArtifact,
} from '../../../data/home-artifacts.mjs';

export async function getStaticPaths() {
  if (process.env.DOTAINFO_STEP14_FIXTURE_BUILD === '1') return [];
  const context = await homeBuildContext();
  return context.playerDays.map(({ day }) => ({ params: { day }, props: { day } }));
}

export async function GET({ props }) {
  return new Response(await homePlayerDayArtifact(props.day), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
