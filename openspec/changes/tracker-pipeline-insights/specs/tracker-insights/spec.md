## Purpose

Give job seekers feedback on whether their search is working: how their applications convert, how long applications sit in each stage, and which applications have gone quiet and need a follow-up.

## ADDED Requirements

### Requirement: Status change timestamp
The system SHALL record, for every application, the time its status last changed (`status_changed_at`).
- On creation it SHALL equal the creation time.
- It SHALL be updated whenever the status changes, regardless of which client or endpoint made the change.
- It SHALL NOT change when other fields (notes, company, role, applied date, archived) are edited or when the status is set to its current value.
- For applications that existed before this change, it SHALL be initialised to their last `updated_at`.

#### Scenario: New application
- **WHEN** a user creates an application with any status
- **THEN** its `status_changed_at` equals its creation time

#### Scenario: Status changes
- **WHEN** a user moves an application from Applied to Interview
- **THEN** its `status_changed_at` is set to the time of that change

#### Scenario: Non-status edit
- **WHEN** a user edits only the notes of an application
- **THEN** its `status_changed_at` is unchanged

#### Scenario: Same status re-saved
- **WHEN** a user saves an application with the status it already has
- **THEN** its `status_changed_at` is unchanged

#### Scenario: Existing data
- **WHEN** the change is deployed
- **THEN** every pre-existing application has `status_changed_at` equal to its `updated_at`

### Requirement: Application payload exposes status change time
Application objects returned by the applications API SHALL include `status_changed_at` as an ISO timestamp.

#### Scenario: List applications
- **WHEN** the client requests the user's applications
- **THEN** each application includes a non-null `status_changed_at`

### Requirement: Insights are computed from non-archived applications only
All insights (tiles, stage ages, gone-quiet list) SHALL be computed from the user's non-archived applications, independent of the tracker's "Show archived" toggle.

#### Scenario: Archived applications ignored
- **WHEN** the user has archived applications and turns on "Show archived"
- **THEN** no insight value changes and no archived application appears in the gone-quiet list

### Requirement: Conversion tiles
The tracker SHALL show three conversion values above the board:
- **Applied**: number of applications whose status is Applied, Interview, Offer or Rejected.
- **Reply rate**: (Interview + Offer + Rejected) ÷ Applied. A rejection counts as a reply.
- **Interview rate**: (Interview + Offer) ÷ Applied.

Rates SHALL be shown as whole percentages. When Applied is 0, both rates SHALL display "—"; the UI SHALL never display `NaN`, `Infinity`, or a misleading `0%` for an undefined rate.

#### Scenario: Mixed pipeline
- **WHEN** the user has 2 Saved, 4 Applied, 2 Interview, 1 Offer and 3 Rejected non-archived applications
- **THEN** Applied shows 10, Reply rate shows 60%, Interview rate shows 30%

#### Scenario: Nothing applied yet
- **WHEN** all non-archived applications are Saved
- **THEN** Applied shows 0 and both rates show "—"

### Requirement: Average days in current stage
The tracker SHALL show, for each open stage (Saved, Applied, Interview), the average number of whole days the stage's current applications have spent in that stage, measured from `status_changed_at` to now. A stage with no applications SHALL display "—". Offer and Rejected are terminal and SHALL NOT show a stage age.

#### Scenario: Stage with applications
- **WHEN** the Applied stage contains two applications that entered it 4 and 10 days ago
- **THEN** Applied shows an average of 7 days

#### Scenario: Empty stage
- **WHEN** no non-archived application is in Interview
- **THEN** Interview shows "—"

#### Scenario: Future timestamp
- **WHEN** an application's `status_changed_at` is later than the client's current time
- **THEN** it counts as 0 days, never a negative value

### Requirement: Per-application days in stage
Each application on the tracker (desktop card and mobile list item) SHALL show how many whole days it has been in its current status.

#### Scenario: Card shows stage age
- **WHEN** an application moved to Interview 5 days ago
- **THEN** its card shows that it has been 5 days in stage

#### Scenario: Status changed on the board
- **WHEN** the user drags a card to another column
- **THEN** the card immediately shows 0 days in stage and all insights recompute without a page reload

### Requirement: Gone-quiet applications
An application SHALL be considered gone quiet when it is non-archived, its status is Applied or Interview, and its `status_changed_at` is strictly more than 14 days before now.

The tracker SHALL show the number of gone-quiet applications and list them oldest status change first, each with role, company and how long it has been quiet. Selecting an entry SHALL open the existing edit dialog for that application. When there are none, the panel SHALL show a short reassuring message instead of an empty list.

#### Scenario: Boundary
- **WHEN** an Applied application's status changed exactly 14 days ago
- **THEN** it is not gone quiet; one second later it is

#### Scenario: Statuses that never go quiet
- **WHEN** a Saved, Offer or Rejected application has not changed status for 60 days
- **THEN** it does not appear in the gone-quiet list

#### Scenario: Notes edit does not reset quiet
- **WHEN** the user edits notes on an Applied application whose status changed 20 days ago
- **THEN** it remains in the gone-quiet list

#### Scenario: Open from list
- **WHEN** the user selects a gone-quiet entry
- **THEN** the existing edit dialog opens for that application

#### Scenario: None quiet
- **WHEN** no application is gone quiet
- **THEN** the panel shows a reassuring message and no list

### Requirement: Snapshot disclaimer
The insights panel SHALL display a short, visible (not hover-only) note that conversion is based on each application's current status, and that rejected applications count as applied regardless of the stage they were rejected at.

#### Scenario: Disclaimer visible
- **WHEN** the insights panel is shown
- **THEN** the snapshot note is visible as text

### Requirement: Panel visibility
The insights panel SHALL render only when the tracker has loaded successfully and the user has at least one non-archived application. While loading, on load error, or with no applications, the tracker's existing states SHALL be shown unchanged.

#### Scenario: No applications
- **WHEN** the user has no non-archived applications
- **THEN** no insights panel is shown and the existing empty state is unchanged

### Requirement: Dashboard follow-up uses the same quiet definition
The dashboard's "Follow up" next-best-action SHALL count applications using the gone-quiet definition above, so the dashboard and the tracker always report the same number.

#### Scenario: Consistent counts
- **WHEN** the tracker lists 3 gone-quiet applications
- **THEN** the dashboard follow-up action (when it is the selected action) says to follow up on 3 applications

#### Scenario: Recently applied not nudged
- **WHEN** the user's only Applied application changed status 10 days ago
- **THEN** the dashboard does not suggest a follow-up for it
