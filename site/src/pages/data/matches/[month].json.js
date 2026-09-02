import {
  historicalMatchShards,
  historicalMonthPayload,
  serializeArtifact,
} from '../../../data/historical-artifacts.mjs';

export async function getStaticPaths() {
  if (process.env.DOTAINFO_STEP14_FIXTURE_BUILD === '1') return [];
  return (await historicalMatchShards()).map((shard) => ({
    params: { month: shard.month },
    props: { month: shard.month },
  }));
}

export async function GET({ props }) {
  return new Response(serializeArtifact(await historicalMonthPayload(props.month)), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
