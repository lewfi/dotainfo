from __future__ import annotations

import json
from datetime import datetime, timezone

from ingest.backfill import ExplorerClient


START = datetime(2026, 8, 1, tzinfo=timezone.utc)
END = datetime(2026, 9, 1, tzinfo=timezone.utc)
LATE_START = datetime(2026, 8, 22, tzinfo=timezone.utc)

start_epoch = int(START.timestamp())
end_epoch = int(END.timestamp())
late_start_epoch = int(LATE_START.timestamp())

sql = f"""
SELECT
    to_char(
        to_timestamp(m.start_time) AT TIME ZONE 'UTC',
        'YYYY-MM-DD'
    ) AS day,
    m.league_tier,
    count(*) AS matches,
    count(*) FILTER (WHERE m.radiant_team_id IS NULL) AS null_radiant,
    count(*) FILTER (WHERE m.dire_team_id IS NULL) AS null_dire
FROM (
    SELECT
        matches.start_time,
        matches.radiant_team_id,
        matches.dire_team_id,
        leagues.tier AS league_tier
    FROM matches
    LEFT JOIN leagues ON leagues.leagueid = matches.leagueid
    WHERE matches.leagueid > 0
) AS m
WHERE m.start_time >= {start_epoch}
  AND m.start_time < {end_epoch}
GROUP BY day, m.league_tier
ORDER BY day, m.league_tier
"""

rows = ExplorerClient().query(sql)
print(json.dumps(rows, ensure_ascii=False, separators=(",", ":")))

total_matches = 0
total_by_tier: dict[str | None, int] = {}
late_by_tier: dict[str | None, int] = {}
total_null_radiant = 0
total_null_dire = 0

for row in rows:
    day = str(row["day"])
    tier = row["league_tier"]
    matches = int(row["matches"])
    total_matches += matches
    total_by_tier[tier] = total_by_tier.get(tier, 0) + matches
    if day >= LATE_START.date().isoformat():
        late_by_tier[tier] = late_by_tier.get(tier, 0) + matches
    total_null_radiant += int(row["null_radiant"])
    total_null_dire += int(row["null_dire"])

print(json.dumps({
    "total_matches": total_matches,
    "total_by_tier": total_by_tier,
    "late_by_tier": late_by_tier,
    "total_null_radiant": total_null_radiant,
    "total_null_dire": total_null_dire,
}, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
