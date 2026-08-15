# Progress

## Attachment Folder Rule

- Attachment files are stored under `data/attachments`.
- Each meeting must use a date-prefixed folder:
  - Format: `YYYY-MM-DD-{회의 제목}`
  - Example: `2026-09-02-고객 피드백 분석 및 대응 방안`
- Do not use title-only folders such as `{회의 제목}` because multiple meetings can share the same title.
- Material files go under:
  - `data/attachments/YYYY-MM-DD-{회의 제목}/materials/{파일명}`
- Audio files go under:
  - `data/attachments/YYYY-MM-DD-{회의 제목}/audio/{파일명}`
- Meeting data stores only the path relative to `data/attachments`.
  - Correct: `2026-09-02-고객 피드백 분석 및 대응 방안/materials/feedback-summary.xlsx`
  - Incorrect: `data/attachments/2026-09-02-고객 피드백 분석 및 대응 방안/materials/feedback-summary.xlsx`
  - Incorrect: `고객 피드백 분석 및 대응 방안/materials/feedback-summary.xlsx`

## Current Attachment Migration

- Existing sample meetings should have test attachment files generated under the date-prefixed folders.
- `data/db/meetings.json` and `data/seed/meetings.sample.json` should both use the same `materialPath` convention.
- The app's default attachment base folder should be `data/attachments`.
- New uploads from the meeting form should pass `YYYY-MM-DD-{회의 제목}` as the meeting folder label.
