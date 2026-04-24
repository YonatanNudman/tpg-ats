// ============================================================
// Core domain types for TPG ATS
// ============================================================

export interface CandidateRow {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  job_id: number;
  stage_id: number;
  recruiter_id: number | null;
  source_id: number | null;
  region_id: number | null;
  motion: "Inbound" | "Outbound";
  status: "Active" | "Hired" | "Rejected";
  rating: number;
  linkedin_url: string;
  resume_url: string;
  notes: string;
  refuse_reason_id: number | null;
  kanban_state: "Normal" | "Blocked" | "Ready";
  post_hire_status: "Active" | "Resigned" | "Terminated" | "OnNotice" | "";
  date_applied: string;
  date_last_stage_update: string;
  created_by: string;
  created_at: string;
  // Computed / joined fields (not stored in sheet)
  full_name?: string;
  job_title?: string;
  stage_name?: string;
  stage_color?: string;
  recruiter_name?: string;
  source_name?: string;
  region_name?: string;
  refuse_reason_name?: string;
  days_in_stage?: number;
  days_since_applied?: number;
}

export interface JobRow {
  id: number;
  title: string;
  department: string;
  location: string;
  region_id: number | null;
  status: "Open" | "On Hold" | "Closed";
  head_count: number;
  recruiter_id: number | null;
  salary_range: string;
  posted_date: string;
  closes_date: string;
  posting_expires: string;
  notes: string;
  created_at: string;
  // Number of head_count slots already filled. Tracked separately from
  // head_count so closing a partially-filled requisition (e.g. 1 of 3
  // hired, role descoped) doesn't lose the historical context that the
  // role originally needed three. `head_count - filled` = open slots.
  filled: number;
  /**
   * Role tier — drives the xDR filter on the waterfall (and, later, tier-
   * specific benchmarks). Replaces the fragile "title contains 'xdr'"
   * string match that missed entries like "Senior xDR", "X.D.R. Bay",
   * "xDR-US". Admin sets once per job.
   *
   * Optional — unset on legacy jobs is fine. The waterfall's xDR filter
   * falls back to the title-substring match when role_tier is missing.
   */
  role_tier?: "xdr" | "mid" | "senior" | "exec" | null;
  // Joined
  recruiter_name?: string;
  region_name?: string;
  candidate_count?: number;
}

export interface HistoryRow {
  id: number;
  timestamp: string;
  candidate_id: number;
  candidate_name: string;
  job_id: number;
  job_title: string;
  stage_from_id: number | null;
  stage_from_name: string;
  stage_to_id: number;
  stage_to_name: string;
  changed_by: string;
  days_in_previous_stage: number;
}

export interface StageRow {
  id: number;
  name: string;
  sequence: number;
  color: string;
  is_hired: boolean;
  is_rejected: boolean;
  is_offer: boolean;
  target_hours: number | null;
  is_enabled: boolean;
  /**
   * Step-to-step conversion benchmark as a percentage (0-100). This is the
   * target % of candidates that should make it from the previous stage into
   * THIS stage, and is rendered in the Waterfall Report's ▲/▼ comparison chip.
   *
   * null on the first stage (no previous to convert from), or any stage the
   * admin hasn't tuned yet. When null, the waterfall falls back to the
   * default xDR positional array (XDR_BENCH in Analytics.ts) — so out-of-box
   * the app still ships with Janice's row-23 benchmarks wired up.
   *
   * Optional on the type (not all callers construct StageRows with it) but
   * always present on rows returned by SheetDB (which reads the column).
   */
  benchmark_pct?: number | null;
}

export interface SourceRow {
  id: number;
  name: string;
  medium: string;
  default_motion: "Inbound" | "Outbound";
  is_enabled: boolean;
}

export interface RegionRow {
  id: number;
  name: string;
  is_enabled: boolean;
}

export interface RecruiterRow {
  id: number;
  name: string;
  email: string;
  is_active: boolean;
}

export interface RefuseReasonRow {
  id: number;
  name: string;
  is_enabled: boolean;
}

export interface SettingsResult {
  stages: StageRow[];
  sources: SourceRow[];
  regions: RegionRow[];
  recruiters: RecruiterRow[];
  refuseReasons: RefuseReasonRow[];
  waterfallBenchmarks: WaterfallBenchmarkRow[];
}

// ============================================================
// Input types
// ============================================================

export interface CandidateFilters {
  jobId?: number | "__unassigned__" | null;
  stageId?: number | null;
  recruiterId?: number | "__unassigned__" | "__assigned__" | null;
  sourceId?: number | "__unassigned__" | null;
  regionId?: number | "__unassigned__" | null;
  motion?: "Inbound" | "Outbound" | "__unassigned__" | null;
  status?: "Active" | "Hired" | "Rejected" | null;
  search?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

export interface CreateCandidateInput {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  job_id: number;
  recruiter_id?: number | null;
  source_id?: number | null;
  region_id?: number | null;
  motion?: "Inbound" | "Outbound";
  linkedin_url?: string;
  notes?: string;
}

export interface UpdateCandidateInput {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  job_id?: number | null;
  recruiter_id?: number | null;
  source_id?: number | null;
  region_id?: number | null;
  motion?: "Inbound" | "Outbound";
  rating?: number;
  linkedin_url?: string;
  resume_url?: string;
  notes?: string;
  kanban_state?: "Normal" | "Blocked" | "Ready";
  post_hire_status?: "Active" | "Resigned" | "Terminated" | "OnNotice" | "";
}

export interface CreateJobInput {
  title: string;
  department: string;
  location: string;
  region_id?: number | null;
  status: "Open" | "On Hold" | "Closed";
  head_count: number;
  filled?: number;
  recruiter_id?: number | null;
  role_tier?: "xdr" | "mid" | "senior" | "exec" | null;
  salary_range?: string;
  posted_date?: string;
  closes_date?: string;
  posting_expires?: string;
  notes?: string;
}

export interface UpdateJobInput extends Partial<CreateJobInput> {}

// ============================================================
// Analytics / Dashboard types
// ============================================================

/**
 * Dashboard scope filters.
 *
 * Plural *Ids / motions fields are the current path — an empty or missing
 * array means "no filter on this axis"; a non-empty array means "match ANY
 * of these values". Legacy singular fields (jobId, recruiterId, etc.) are
 * still accepted so existing tests + any unmigrated call sites keep working.
 *
 * Normalization rule (enforced in filterCandidates / computeWaterfall):
 *   - If the plural array is set and non-empty, it wins and the single
 *     field is ignored on that axis.
 *   - Otherwise the single field is promoted into a one-element array.
 *   - Empty array (or both unset) = no filter on this axis.
 */
export interface DashboardFilters {
  // Legacy single-value scope — honored when its plural counterpart is absent/empty.
  jobId?: number | "__unassigned__" | null;
  recruiterId?: number | "__unassigned__" | "__assigned__" | null;
  sourceId?: number | "__unassigned__" | null;
  regionId?: number | "__unassigned__" | null;
  motion?: "Inbound" | "Outbound" | "__unassigned__" | null;
  status?: "Active" | "Hired" | "Rejected" | null;
  // Multi-value scope. Empty / unset = all.
  jobIds?: Array<number | "__unassigned__"> | null;
  recruiterIds?: Array<number | "__unassigned__" | "__assigned__"> | null;
  sourceIds?: Array<number | "__unassigned__"> | null;
  regionIds?: Array<number | "__unassigned__"> | null;
  motions?: Array<"Inbound" | "Outbound" | "__unassigned__"> | null;
  startDate: string;
  endDate: string;
}

export interface KpiData {
  activeCandidates: number;
  openPositions: number;
  hiresThisPeriod: number;
  slaBreaches: number;
  avgDaysToHire: number;
  offerAcceptanceRate: number;
  expiredPostings: number;
  expiringPostings: number;
}

export interface PipelineSnapshotItem {
  stage_id: number;
  stage_name: string;
  stage_color: string;
  sequence: number;
  candidate_count: number;
}

export interface FunnelItem {
  stage_id: number;
  stage_name: string;
  sequence: number;
  entered_count: number;
  conversion_rate: number;
}

export interface RecruiterPerformanceItem {
  recruiter_id: number;
  recruiter_name: string;
  total_candidates: number;
  active_candidates: number;
  /**
   * Currently active candidates (status === 'Active') assigned to this
   * recruiter. Same value as `active_candidates` — kept as a separate
   * field so the dashboard table can show both "your queue right now"
   * and "your historical caseload" if those ever diverge (e.g. when
   * we add custom queue states beyond Active).
   */
  queue: number;
  hires: number;
  /**
   * Hires within the section's hires-period filter (independent of the
   * dashboard's primary date range). When the dashboard's "Hires period"
   * picker is set differently from the global period, this column shows
   * a different number than `hires`. When unset, equal to `hires`.
   */
  hires_in_period: number;
  rejections: number;
  avg_days_to_hire: number;
}

export interface SourceEffectivenessItem {
  source_id: number;
  source_name: string;
  medium: string;
  total_candidates: number;
  hired_candidates: number;
  hire_rate: number;
}

export interface MonthlyTrendItem {
  month_label: string;
  avg_days_to_hire: number;
}

export interface StageVelocityItem {
  stage_id: number;
  stage_name: string;
  stage_color: string;
  avg_days_in_stage: number;
  candidate_count: number;
  /** How many candidates were rejected FROM this stage in the period.
   *  Surfaces the "where do we lose people" question alongside dwell time. */
  rejected_count: number;
}

/**
 * Aggregated rejection-reason breakdown for the Analytics section.
 * Counts each candidate currently in `Rejected` status (within the date
 * range) by their refuse_reason_id, joined to the reason name for display.
 * Intentionally excludes candidates with `refuse_reason_id` blank — those
 * pre-date the structured-reason workflow and would otherwise crowd the
 * top of the list as "(none)".
 */
export interface RejectionReasonItem {
  reason_id: number;
  reason_name: string;
  count: number;
}

export interface SlaBreachItem {
  candidate_id: number;
  candidate_name: string;
  stage_name: string;
  stage_color: string;
  job_title: string;
  recruiter_name: string;
  hours_in_stage: number;
  target_hours: number;
  hours_overdue: number;
}

/**
 * Candidates that have been in their stage much longer than expected.
 * Severity tiers:
 *   "sla"        — past target_hours but under 2× (already the existing SLA breach view)
 *   "stale"      — past 2× target_hours, or >14 days if stage has no SLA
 *   "abandoned"  — past 4× target_hours, or >30 days if stage has no SLA
 */
export interface StaleCandidateItem {
  candidate_id: number;
  candidate_name: string;
  stage_name: string;
  stage_color: string;
  job_title: string;
  recruiter_name: string;
  days_in_stage: number;
  severity: "stale" | "abandoned";
}

/**
 * Cohort waterfall metrics — different from the snapshot funnel.
 *
 * Snapshot funnel: "how many candidates are in each stage RIGHT NOW".
 * Waterfall: "of the candidates who entered the funnel in the window,
 *             how many have ever reached each stage".
 *
 * The waterfall is what compares directly to TPG Recruiting Weekly Update
 * row 23 ("US xDR AVERAGES"): 100 → 50 → 40 → 30 → 24 → 19 → 17 → 16 per
 * recruiter per month, with step-to-step rates of 50, 80, 75, 80, 79, 89, 94%.
 */
export interface WaterfallItem {
  stage_id: number;
  stage_name: string;
  stage_color: string;
  sequence: number;
  /** Candidates in the cohort whose max-stage-reached ≥ this stage's sequence. */
  count: number;
  /** count / previous_stage_count * 100 (null for the first row). */
  step_pct: number | null;
  /** xDR benchmark for this transition (null when no benchmark at this position
   *  or when stage count doesn't match the expected 8-stage shape). */
  bench_pct: number | null;
  /** true if step_pct >= bench_pct, false if below, null when either side is null. */
  bench_above: boolean | null;
  /** IDs of cohort candidates whose max-stage-reached ≥ this stage's sequence.
   *  Powers the click-to-expand drilldown without needing a second round trip. */
  candidate_ids: number[];
}

export interface WaterfallResult {
  /** Total unique candidates in the cohort (match date window + scope filters).
   *  In All-Time mode, candidates with no date_applied are included; with an
   *  explicit window they're excluded and counted in `excludedNoDate`. */
  cohortSize: number;
  rows: WaterfallItem[];
  window: { startDate: string; endDate: string };
  /** True when the active stage configuration matches the expected 8-stage positional
   *  shape that XDR_BENCH was built against. When false, bench_pct is null everywhere
   *  and the UI should show a "—" plus a tooltip explaining why. */
  benchmarksValid: boolean;
  /** Count of candidates dropped because they have no date_applied AND a
   *  window was set. UI surfaces this as "(N excluded — missing date)" so
   *  an admin understands why cohortSize looks smaller than Pipeline Funnel's
   *  total. Always 0 in All-Time mode. */
  excludedNoDate: number;
}

export interface WaterfallFilters {
  startDate: string;
  endDate: string;
  // Scope — same dual single/multi shape as DashboardFilters. See the
  // normalization rule on DashboardFilters for how plural vs. single
  // fields resolve at the filter-evaluation boundary.
  jobId?: number | "__unassigned__" | null;
  recruiterId?: number | "__unassigned__" | "__assigned__" | null;
  sourceId?: number | "__unassigned__" | null;
  regionId?: number | "__unassigned__" | null;
  motion?: "Inbound" | "Outbound" | "__unassigned__" | null;
  jobIds?: Array<number | "__unassigned__"> | null;
  recruiterIds?: Array<number | "__unassigned__" | "__assigned__"> | null;
  sourceIds?: Array<number | "__unassigned__"> | null;
  regionIds?: Array<number | "__unassigned__"> | null;
  motions?: Array<"Inbound" | "Outbound" | "__unassigned__"> | null;
  /** @deprecated Legacy field — kept for back-compat with older clients.
   *  The new UI filters by specific job, not by tier. */
  roleTier?: "xdr" | "mid" | "senior" | "exec" | null;
  /** @deprecated Same story as `roleTier`. */
  xdrOnly?: boolean;
}

/**
 * Waterfall benchmark — keyed by (stage_id, job_id).
 *
 * `job_id === 0` is the default row (applies to every job). A positive
 * job_id is an override that wins only when the waterfall is filtered
 * to exactly that single job. This lets admins:
 *   1. Tune one set of defaults that covers the 80% case
 *   2. Override specific jobs where reality differs (e.g. exec searches
 *      convert very differently from the xDR default)
 *
 * Lives in its own sheet so the admin UI can edit it without risking
 * stage-row writes. Seeded from the xDR values on first run.
 *
 * Note: older seed data may have a `role_tier` string in the job_id
 * column. The SheetDB reader treats non-numeric values as the default
 * row (job_id = 0), so legacy data doesn't break reads.
 */
export interface WaterfallBenchmarkRow {
  id: number;
  stage_id: number;
  /** 0 = default benchmark that applies to all jobs.
   *  Positive = override for that specific job. */
  job_id: number;
  /** 0-100. Target % of previous stage that should reach this stage. */
  benchmark_pct: number;
}

/**
 * Bundle returned by `getDashboardData` for the funnel-primary layout.
 *
 * Trimmed after the funnel-primary refactor — the following fields used to
 * be on this shape but are no longer consumed anywhere on the frontend, so
 * they are no longer computed:
 *   - kpis             (KPI strip retired; metrics live on the funnel + perf cards)
 *   - pipelineSnapshot (funnel is computed client-side from allCandidates)
 *   - recentHires      (use the standalone getRecentHires endpoint instead)
 *
 * The compute functions for those metrics (computeKpis, computePipelineSnapshot)
 * are still exported and unit-tested; they're just no longer called by the
 * dashboard bundle.
 */
export interface DashboardResult {
  funnelConversion: FunnelItem[];
  recruiterPerformance: RecruiterPerformanceItem[];
  sourceEffectiveness: SourceEffectivenessItem[];
  timeToHireTrend: MonthlyTrendItem[];
  stageVelocity: StageVelocityItem[];
  rejectionReasons: RejectionReasonItem[];
  slaBreaches: SlaBreachItem[];
  staleCandidates: StaleCandidateItem[];
}

export interface CandidateDetailResult {
  candidate: CandidateRow;
  history: HistoryRow[];
}

// ============================================================
// SheetDB interface (all Google Sheets I/O lives here)
// ============================================================

export interface ISheetDB {
  // Candidates
  getAllCandidates(): CandidateRow[];
  getCandidateById(id: number): CandidateRow | null;
  appendCandidate(row: Omit<CandidateRow, "id">): CandidateRow;
  updateCandidate(id: number, updates: Partial<CandidateRow>): void;
  deleteCandidate(id: number): void;

  // Jobs
  getAllJobs(): JobRow[];
  getJobById(id: number): JobRow | null;
  appendJob(row: Omit<JobRow, "id">): JobRow;
  updateJob(id: number, updates: Partial<JobRow>): void;
  deleteJob(id: number): void;

  // History
  appendHistory(row: Omit<HistoryRow, "id">): void;
  getHistoryForCandidate(candidateId: number): HistoryRow[];
  getAllHistory(): HistoryRow[];

  // Settings
  getAllStages(): StageRow[];
  getAllSources(): SourceRow[];
  getAllRegions(): RegionRow[];
  getAllRecruiters(): RecruiterRow[];
  getAllRefuseReasons(): RefuseReasonRow[];
  getAllWaterfallBenchmarks(): WaterfallBenchmarkRow[];
  replaceStages(rows: StageRow[]): void;
  replaceSources(rows: SourceRow[]): void;
  replaceRegions(rows: RegionRow[]): void;
  replaceRecruiters(rows: RecruiterRow[]): void;
  replaceRefuseReasons(rows: RefuseReasonRow[]): void;
  replaceWaterfallBenchmarks(rows: WaterfallBenchmarkRow[]): void;
  seedDefaultData(): void;
}
