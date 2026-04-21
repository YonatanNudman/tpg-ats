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
}

// ============================================================
// Input types
// ============================================================

export interface CandidateFilters {
  jobId?: number | null;
  stageId?: number | null;
  recruiterId?: number | null;
  sourceId?: number | null;
  regionId?: number | null;
  motion?: "Inbound" | "Outbound" | null;
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
  source_id?: number | null;
  region_id?: number | null;
  motion?: "Inbound" | "Outbound";
  notes?: string;
}

export interface UpdateCandidateInput {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
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
  recruiter_id?: number | null;
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

export interface DashboardFilters {
  jobId?: number | null;
  recruiterId?: number | null;
  sourceId?: number | null;
  regionId?: number | null;
  motion?: "Inbound" | "Outbound" | null;
  status?: "Active" | "Hired" | "Rejected" | null;
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
  hires: number;
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

export interface DashboardResult {
  kpis: KpiData;
  pipelineSnapshot: PipelineSnapshotItem[];
  funnelConversion: FunnelItem[];
  recruiterPerformance: RecruiterPerformanceItem[];
  sourceEffectiveness: SourceEffectivenessItem[];
  timeToHireTrend: MonthlyTrendItem[];
  stageVelocity: StageVelocityItem[];
  slaBreaches: SlaBreachItem[];
  recentHires: CandidateRow[];
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
  replaceStages(rows: StageRow[]): void;
  replaceSources(rows: SourceRow[]): void;
  replaceRegions(rows: RegionRow[]): void;
  replaceRecruiters(rows: RecruiterRow[]): void;
  replaceRefuseReasons(rows: RefuseReasonRow[]): void;
  seedDefaultData(): void;
}
