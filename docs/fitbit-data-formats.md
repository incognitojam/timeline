# Fitbit Data Formats in Google Takeout

## Overview

Fitbit data is included in Google Takeout exports. The export format changed significantly between August 2024 and late 2025, with data reorganized into different folder structures.

## Current Parser Status

**Implemented** (`src/parsers/fitbit.ts`):
- Parses both **Aug 2024 format** (old) and **Jan 2026 format** (new)
- Format is auto-detected based on files present
- Integrated with inbox auto-processing (`src/inbox/zip-handlers.ts`)

**Event types created**:

| Type | Old Format | New Format |
|------|------------|------------|
| `sleep` / `sleep:nap` | Yes (with stage transitions) | Yes (scores only) |
| `daily:readiness` | Yes | Yes |
| `daily:stress` | Yes | No (not in new format) |
| `daily:hrv` | Yes (histogram) | Yes (daily summary) |
| `daily:spo2` | No | Yes |
| `daily:breathing` | No | Yes |

## Data Format Comparison

### Old Format (Aug 2024 takeout) - IMPLEMENTED

| Data Type | Location | Format |
|-----------|----------|--------|
| **Sleep records** | `Global Export Data/sleep-YYYY-MM-DD.json` | JSON with full stage data |
| **Sleep scores** | `Sleep Score/sleep_score.csv` | CSV |
| **Daily readiness** | `Daily Readiness/Daily Readiness Score - YYYY-MM-DD.csv` | Monthly CSVs |
| **Stress scores** | `Stress Score/Stress Score.csv` | Single CSV |
| **HRV** | `Heart Rate Variability/Heart Rate Variability Histogram - YYYY-MM-DD.csv` | Monthly CSVs |

**Sleep JSON structure** (old format, synthetic values):
```json
{
  "logId": 90000000001,
  "dateOfSleep": "2099-01-02",
  "startTime": "2099-01-02T00:00:00.000",
  "endTime": "2099-01-02T08:00:00.000",
  "duration": 28800000,
  "minutesAsleep": 420,
  "minutesAwake": 60,
  "efficiency": 88,
  "mainSleep": true,
  "levels": {
    "summary": {
      "deep": { "count": 4, "minutes": 90, "thirtyDayAvgMinutes": 90 },
      "light": { "count": 8, "minutes": 240 },
      "rem": { "count": 4, "minutes": 90 },
      "wake": { "count": 6, "minutes": 60 }
    },
    "data": [
      { "dateTime": "2099-01-02T00:00:00.000", "level": "wake", "seconds": 300 },
      { "dateTime": "2099-01-02T00:05:00.000", "level": "deep", "seconds": 5400 },
      ...
    ]
  }
}
```

### New Format (Jan 2026 takeout) - IMPLEMENTED

| Data Type | Location | Format |
|-----------|----------|--------|
| **Sleep scores** | `Health Fitness Data_GoogleData/UserSleepScores_YYYY-MM-DD.csv` | Yearly CSVs |
| **Daily readiness** | `Daily Readiness/Daily Readiness Score - YYYY-MM-DD.csv` | Monthly CSVs (same) |
| **Daily HRV** | `Heart Rate Variability/Daily Heart Rate Variability Summary - YYYY-MM-*.csv` | Per-day CSVs |
| **Daily SpO2** | `Oxygen Saturation (SpO2)/Daily SpO2 - YYYY-MM-DD-YYYY-MM-DD.csv` | Range CSVs |
| **Breathing rate** | `Physical Activity_GoogleData/respiratory_rate_sleep_summary_YYYY-MM-DD.csv` | Monthly CSVs |
| **Sleep temp** | `Physical Activity_GoogleData/daily_sleep_temperature_derivations.csv` | Single CSV |

**Sleep scores CSV structure** (new format):
```csv
sleep_id,sleep_score_id,data_source,score_utc_offset,score_time,overall_score,duration_score,composition_score,revitalization_score,sleep_time_minutes,deep_sleep_minutes,rem_sleep_percent,resting_heart_rate,sleep_goal_minutes,waso_count_long_wakes,waso_count_all_wake_time,restlessness_normalized,hr_below_resting_hr,sleep_score_created,sleep_score_last_updated
```

**Daily HRV CSV structure**:
```csv
timestamp,rmssd,nremhr,entropy
2099-01-02T00:00:00,40.0,60.0,3.0
```

**Daily SpO2 CSV structure**:
```csv
timestamp,average_value,lower_bound,upper_bound
2099-01-02T00:00:00Z,96.0,94.0,98.0
```

**Respiratory rate sleep summary**:
```csv
timestamp,deep sleep stats - milli breaths per minute,deep sleep stats - standard deviation,...,light sleep stats,...,rem sleep stats,...,full sleep stats,...
```

## Key Differences

| Aspect | Old Format | New Format |
|--------|------------|------------|
| Sleep stage transitions | Full `levels.data` array with every transition | Not available |
| Sleep summaries | In sleep JSON | Separate `UserSleepScores` CSV |
| HRV | Histogram CSVs | Daily summary CSVs with RMSSD |
| SpO2 | Minute-level + daily | Daily averages with bounds |
| Breathing rate | Not separate | Per-sleep-stage breakdown |
| File organization | `Global Export Data/` for main data | `Health Fitness Data_GoogleData/` |

## Takeout Locations

- **Local extract**: `~/.local/share/timeline/imports/fitbit/` (preferred) or `./imports/fitbit/`

## Implementation Notes

### Current parser (`src/parsers/fitbit.ts`)

- Exports `importFitbitData(db, importPath, sourceAccount)` for inbox integration
- Uses `INSERT OR IGNORE` with `source_id` for deduplication
- Source IDs: `sleep:{logId}`, `readiness:{date}`, `stress:{date}`, `hrv:{date}`
- Stores full JSON in `raw_data` for future reprocessing

### Source ID Strategy

Old and new formats coexist without collision:
- Old sleep: `sleep:{logId}` from JSON
- New sleep: `sleep-new:{sleep_id}` from CSV
- Daily metrics: `hrv:{date}`, `spo2:{date}`, `breathing:{date}`, `readiness:{date}`, `stress:{date}`

### Tags

Events are tagged to distinguish formats:
- Old format: `["fitbit", "deep", "light", "rem", ...]` (stage-specific tags)
- New format: `["fitbit", "new-format", "sleep"]`, `["fitbit", "new-format", "hrv"]`, etc.

## Files

- Parser: `src/parsers/fitbit.ts`
- Inbox detection: `src/inbox/zip.ts` (`detectTakeoutServices`)
- Inbox handler: `src/inbox/zip-handlers.ts` (`case "fitbit":`)
- This doc: `docs/fitbit-data-formats.md`
