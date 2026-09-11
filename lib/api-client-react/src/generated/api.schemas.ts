chedCurrentSubscribers: number;
  unsubscribeEvidence: number;
  bounceEvidence: number;
}

export interface NewsletterCampaign {
  id: string;
  subject: string;
  sentAt: string;
  sentTimeText?: string | null;
  previewUrl?: string | null;
  openRate?: number | null;
  clickRate?: number | null;
  trackedRecipientCount: number;
  openedCount: number;
  clickedCount: number;
  linkedCount: number;
}

export interface NewsletterOverview {
  audience: NewsletterAudienceSummary;
  campaigns: NewsletterCampaign[];
}

export type NewsletterContactLinkedRecordType = typeof NewsletterContactLinkedRecordType[keyof typeof NewsletterContactLinkedRecordType] | null;


export const NewsletterContactLinkedRecordType = {
  person: 'person',
  organization: 'organization',
  household: 'household',
  payment_intermediary: 'payment_intermediary',
} as const;

export interface NewsletterContact {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  sourceCurrentSubscriber: boolean;
  sourceUnsubscribed: boolean;
  sourceBounced: boolean;
  linkedRecordType?: NewsletterContactLinkedRecordType;
  linkedRecordId?: string | null;
  linkedRecordName?: string | null;
}

export interface NewsletterContactList {
  data: NewsletterContact[];
  pagination: Pagination;
}

export type NewsletterEngagementLinkedRecordType = typeof NewsletterEngagementLinkedRecordType[keyof typeof NewsletterEngagementLinkedRecordType] | null;


export const NewsletterEngagementLinkedRecordType = {
  person: 'person',
  organization: 'organization',
  household: 'household',
  payment_intermediary: 'payment_intermediary',
} as const;

export interface NewsletterEngagement {
  campaignId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  deliveredAt?: string | null;
  opened: boolean;
  lastOpenedAt?: string | null;
  totalOpens: number;
  clicked: boolean;
  lastClickedAt?: string | null;
  totalClicks: number;
  clickedLinks: string[];
  linkedRecordType?: NewsletterEngagementLinkedRecordType;
  linkedRecordId?: string | null;
  linkedRecordName?: string | null;
}

export interface NewsletterEngagementList {
  data: NewsletterEngagement[];
  pagination: Pagination;
}

export interface PersonNewsletterEngagement {
  campaignId: string;
  campaignSubject: string;
  sentAt: string;
  previewUrl?: string | null;
  email: string;
  deliveredAt?: string | null;
  opened: boolean;
  lastOpenedAt?: string | null;
  totalOpens: number;
  clicked: boolean;
  lastClickedAt?: string | null;
  totalClicks: number;
  clickedLinks: string[];
}

export interface PersonNewsletterEngagementList {
  data: PersonNewsletterEngagement[];
  pagination: Pagination;
}

export type NewsletterSubscriptionDifferenceFlodeskStatus = typeof NewsletterSubscriptionDifferenceFlodeskStatus[keyof typeof NewsletterSubscriptionDifferenceFlodeskStatus];


export const NewsletterSubscriptionDifferenceFlodeskStatus = {
  subscribed: 'subscribed',
  unsubscribed: 'unsubscribed',
} as const;

export type NewsletterSubscriptionDifferenceCrmStatus = typeof NewsletterSubscriptionDifferenceCrmStatus[keyof typeof NewsletterSubscriptionDifferenceCrmStatus];


export const NewsletterSubscriptionDifferenceCrmStatus = {
  subscribed: 'subscribed',
  unsubscribed: 'unsubscribed',
  not_subscribed: 'not_subscribed',
} as const;

export interface NewsletterSubscriptionDifference {
  personId: string;
  personName: string;
  email: string;
  flodeskStatus: NewsletterSubscriptionDifferenceFlodeskStatus;
  crmStatus: NewsletterSubscriptionDifferenceCrmStatus;
}

export interface NewsletterSubscriptionDifferenceSummary {
  total: number;
  examples: NewsletterSubscriptionDifference[];
}

export type NewsletterEmailDifferenceMatchBasis = typeof NewsletterEmailDifferenceMatchBasis[keyof typeof NewsletterEmailDifferenceMatchBasis];


export const NewsletterEmailDifferenceMatchBasis = {
  exact_name: 'exact_name',
} as const;

export interface NewsletterEmailDifference {
  personId: string;
  personName: string;
  flodeskEmail: string;
  crmEmails: string[];
  matchBasis: NewsletterEmailDifferenceMatchBasis;
}

export interface NewsletterEmailDifferenceSummary {
  total: number;
  examples: NewsletterEmailDifference[];
}

export interface NewsletterImportResult {
  campaigns: number;
  audienceRecords: number;
  engagementRecords: number;
  linkedAudienceRecords: number;
  unmatchedAudienceRecords: number;
  peopleSubscribed: number;
  peopleUnsubscribed: number;
  bouncedEmailsInvalidated: number;
  /** Always false. Workbook imports preserve source evidence without changing CRM subscription or email fields. */
  operationalRecordsChanged: boolean;
  subscriptionDifferences: NewsletterSubscriptionDifferenceSummary;
  emailDifferences: NewsletterEmailDifferenceSummary;
}

export type AppFeedbackCategory = typeof AppFeedbackCategory[keyof typeof AppFeedbackCategory];


export const AppFeedbackCategory = {
  bug: 'bug',
  question: 'question',
  suggestion: 'suggestion',
  other: 'other',
} as const;

export type AppFeedbackStatus = typeof AppFeedbackStatus[keyof typeof AppFeedbackStatus];


export const AppFeedbackStatus = {
  open: 'open',
  in_progress: 'in_progress',
  resolved: 'resolved',
  dismissed: 'dismissed',
} as const;

export type AppFeedbackScreenshotStatus = typeof AppFeedbackScreenshotStatus[keyof typeof AppFeedbackScreenshotStatus];


export const AppFeedbackScreenshotStatus = {
  captured: 'captured',
  failed: 'failed',
  skipped: 'skipped',
} as const;

export interface AppFeedbackPerson {
  id: string;
  name: string | null;
  email: string | null;
}

export interface AppFeedbackProposalCodeArea {
  area: string;
  rationale: string;
}

export interface AppFeedbackProposalContent {
  title: string;
  summary: string;
  userExperience: string[];
  implementationSteps: string[];
  likelyCodeAreas: AppFeedbackProposalCodeArea[];
  acceptanceCriteria: string[];
  testPlan: string[];
  risksAndOpenQuestions: string[];
  implementationBrief: string;
}

export type AppFeedbackProposalGenerationStatus = typeof AppFeedbackProposalGenerationStatus[keyof typeof AppFeedbackProposalGenerationStatus];


export const AppFeedbackProposalGenerationStatus = {
  queued: 'queued',
  generating: 'generating',
  ready: 'ready',
  error: 'error',
} as const;

export type AppFeedbackProposalContextSnapshot = { [key: string]: unknown };

export interface AppFeedbackProposal {
  id: string;
  feedbackId: string;
  generationStatus: AppFeedbackProposalGenerationStatus;
  /** @minimum 1 */
  revision: number;
  contextSnapshot: AppFeedbackProposalContextSnapshot;
  proposal: AppFeedbackProposalContent | null;
  reviewerGuidance: string | null;
  analyzedAt: string | null;
  model: string | null;
  error: string | null;
  implementationRequestedAt: string | null;
  implementationRequestedByUserId: string | null;
  implementationRequestedBy: AppFeedbackPerson | null;
  createdAt: string;
  updatedAt: string;
}

export type AppFeedbackItemContext = { [key: string]: unknown };

export interface AppFeedbackItem {
  id: string;
  createdByUserId: string;
  category: AppFeedbackCategory;
  message: string;
  status: AppFeedbackStatus;
  pageUrl: string;
  pagePath: string;
  pageTitle: string | null;
  context: AppFeedbackItemContext;
  screenshotUrl: string | null;
  screenshotFilename: string | null;
  screenshotStatus: AppFeedbackScreenshotStatus;
  screenshotError: string | null;
  adminNotes: string | null;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  reporter: AppFeedbackPerson;
  resolver: AppFeedbackPerson | null;
  proposal: AppFeedbackProposal | null;
  /** Whether the authenticated viewer may start the implementation handoff. The API remains authoritative even when the UI hides the action. */
  viewerCanImplement: boolean;
}

export type CreateAppFeedbackBodyContext = { [key: string]: unknown };

export interface CreateAppFeedbackBody {
  category?: AppFeedbackCategory;
  /**
   * @minLength 1
   * @maxLength 10000
   */
  message: string;
  /**
   * @minLength 1
   * @maxLength 5000
   */
  pageUrl: string;
  /**
   * @minLength 1
   * @maxLength 3000
   */
  pagePath: string;
  /** @maxLength 500 */
  pageTitle?: string | null;
  context?: CreateAppFeedbackBodyContext;
  /**
   * @maxLength 2048
   * @pattern ^/api/storage/objects/
   */
  screenshotUrl?: string | null;
  /** @maxLength 500 */
  screenshotFilename?: string | null;
  screenshotStatus?: AppFeedbackScreenshotStatus;
  /** @maxLength 2000 */
  screenshotError?: string | null;
}

export interface UpdateAppFeedbackBody {
  status?: AppFeedbackStatus;
  /** @maxLength 20000 */
  adminNotes?: string | null;
}

export interface ReviseAppFeedbackProposalBody {
  /**
   * @minLength 1
   * @maxLength 20000
   */
  reviewerGuidance: string;
}

export interface AppFeedbackList {
  data: AppFeedbackItem[];
  pagination: Pagination;
}

/**
 * Not found
 */
export type NotFoundResponse = ErrorResponse;

/**
 * Bad request (validation error)
 */
export type BadRequestResponse = ErrorResponse;

/**
 * Forbidden (admin access required)
 */
export type ForbiddenResponse = ErrorResponse;

/**
 * Forbidden — finance-team or admin role required (error code finance_role_required).
 */
export type FinanceForbiddenResponse = ErrorResponse;

export type LimitParameter = number;

export type PageParameter = number;

/**
 * Admin-only: when true, include archived (soft-deleted) rows. Ignored for non-admins — they never see archived rows even if this is passed.
 */
export type IncludeArchivedQueryParameter = boolean;

export type SearchParams = {
/**
 * Search query (min 2 chars; shorter returns empty groups).
 */
q: string;
/**
 * Max hits returned per entity group.
 * @minimum 1
 * @maximum 20
 */
limitPerType?: number;
/**
 * Admin-only: when true, include archived (soft-deleted) rows. Ignored for non-admins — they never see archived rows even if this is passed.
 */
includeArchived?: IncludeArchivedQueryParameter;
};

export type ListPotentialDuplicatesParams = {
/**
 * Which entity type to scan for duplicates.
 */
type: ListPotentialDuplicatesType;
/**
 * Max candidate pairs to return.
 * @minimum 1
 * @maximum 200
 */
limit?: number;
};

export type ListPotentialDuplicatesType = typeof ListPotentialDuplicatesType[keyof typeof ListPotentialDuplicatesType];


export const ListPotentialDuplicatesType = {
  organization: 'organization',
  person: 'person',
} as const;

export type ListFinancialCorrectionsParams = {
/**
 * Max proposals to return.
 * @minimum 1
 * @maximum 200
 */
limit?: number;
};

export type ListCleanupQueueParams = {
/**
 * Filter by status. Omit to get open items only.
 */
status?: CleanupQueueStatus;
proposalKind?: CleanupProposalKind;
reasonCode?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListCodingFormRowsParams = {
/**
 * Filter by apply status. Omit for all.
 */
status?: CodingFormRowStatus;
/**
 * Filter by source sheet.
 */
source?: ListCodingFormRowsSource;
/**
 * Filter by match confidence tier.
 */
matchTier?: ListCodingFormRowsMatchTier;
/**
 * When true, only rows carrying a grant-agreement Drive link (the grant-agreement backfill queue).
 */
hasDriveLink?: boolean;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListCodingFormRowsSource = typeof ListCodingFormRowsSource[keyof typeof ListCodingFormRowsSource];


export const ListCodingFormRowsSource = {
  fy24: 'fy24',
  fy25: 'fy25',
  fy26: 'fy26',
  fy27: 'fy27',
  girasol: 'girasol',
} as const;

export type ListCodingFormRowsMatchTier = typeof ListCodingFormRowsMatchTier[keyof typeof ListCodingFormRowsMatchTier];


export const ListCodingFormRowsMatchTier = {
  high: 'high',
  suggested: 'suggested',
  none: 'none',
} as const;

export type ListEmailProposalsParams = {
kind?: EmailProposalKind;
status?: EmailProposalStatus;
mailboxUserId?: string;
/**
 * Admin-only: when true, list proposals across ALL synced mailboxes (each row carries mailboxUserName). Ignored for non-admins — they only ever see their own mailbox.
 */
allMailboxes?: boolean;
/**
 * Filter to proposals targeting this person.
 */
personId?: string;
/**
 * Filter to proposals targeting this funder.
 */
organizationId?: string;
/**
 * With organizationId, also include proposals targeting people who hold a current role at that organization.
 */
includeLinkedPeople?: boolean;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type GetTaskProposalParams = {
/**
 * Entity to suggest a next step for (person).
 */
personId?: string;
/**
 * Entity to suggest a next step for (organization).
 */
organizationId?: string;
};

export type ListAppFeedbackParams = {
status?: typeof ListAppFeedbackStatus[keyof typeof ListAppFeedbackStatus];
category?: typeof ListAppFeedbackCategory[keyof typeof ListAppFeedbackCategory];
/**
 * @maxLength 500
 */
search?: string;
/**
 * @minimum 1
 */
page?: number;
/**
 * @minimum 1
 * @maximum 100
 */
limit?: number;
};

export const ListAppFeedbackStatus = {...AppFeedbackStatus,  all: 'all',
} as const
export const ListAppFeedbackCategory = {...AppFeedbackCategory,  all: 'all',
} as const
export type AdminDiscardEmailIntelPrompt200 = {
  ok: boolean;
};

export type AdminListEmailIntelFeedbackParams = {
kind?: EmailProposalKind;
status?: EmailProposalStatus;
/**
 * Filter the feed by who resolved each proposal. `all` (default) returns every resolved proposal. `real` excludes feedback authored by automated test accounts (the "Test Dev"/"Test Admin" users auto-provisioned during end-to-end test runs), leaving only feedback from real human reviewers.

 */
reviewerSource?: AdminListEmailIntelFeedbackReviewerSource;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type AdminListEmailIntelFeedbackReviewerSource = typeof AdminListEmailIntelFeedbackReviewerSource[keyof typeof AdminListEmailIntelFeedbackReviewerSource];


export const AdminListEmailIntelFeedbackReviewerSource = {
  all: 'all',
  real: 'real',
} as const;

export type ListUnrecognizedCorrespondentsParams = {
mailboxUserId?: string;
/**
 * Admin-only: when true, aggregate unrecognized correspondents across ALL synced mailboxes (each row carries mailboxUserId + mailboxUserName). Ignored for non-admins.
 */
allMailboxes?: boolean;
/**
 * @minimum 1
 * @maximum 365
 */
days?: number;
/**
 * @minimum 1
 */
minThreads?: number;
};

export type ListRegionsParams = {
/**
 * Admin-only: when true, include archived (soft-deleted) rows. Ignored for non-admins — they never see archived rows even if this is passed.
 */
includeArchived?: IncludeArchivedQueryParameter;
type?: RegionType;
/**
 * Case-insensitive match against name, displayPath, stateAbbreviation, and aliases.
 */
search?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type GetRegionContainmentParams = {
/**
 * Region ids to expand (max 200).
 */
ids: string[];
};

export type ListSchoolsParams = {
/**
 * Admin-only: when true, include archived (soft-deleted) rows. Ignored for non-admins — they never see archived rows even if this is passed.
 */
includeArchived?: IncludeArchivedQueryParameter;
status?: SchoolStatus;
governanceModel?: GovernanceModel;
search?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListFiscalYearEntityGoalsParams = {
/**
 * Filter by fiscal_year.id
 */
fyId?: string;
/**
 * Filter by entity.id
 */
entityId?: string;
/**
 * Filter by category. Accepts the new loan/grant tokens AND the legacy revenue/loan_capital tokens.
 */
category?: GoalCategoryParam;
};

export type ListFundraisingCampaignsParams = {
/**
 * Admin-only: when true, include archived (soft-deleted) rows. Ignored for non-admins — they never see archived rows even if this is passed.
 */
includeArchived?: IncludeArchivedQueryParameter;
};

export type ListFundableProjectsParams = {
/**
 * Admin-only: when true, include archived (soft-deleted) rows. Ignored for non-admins — they never see archived rows even if this is passed.
 */
includeArchived?: IncludeArchivedQueryParameter;
};

export type ListFiscalYearsParams = {
/**
 * Admin-only: when true, include archived (soft-deleted) rows. Ignored for non-admins — they never see archived rows even if this is passed.
 */
includeArchived?: IncludeArchivedQueryParameter;
};

export type ListOrganizationsParams = {
/**
 * Admin-only: when true, include archived (soft-deleted) rows. Ignored for non-admins — they never see archived rows even if this is passed.
 */
includeArchived?: IncludeArchivedQueryParameter;
search?: string;
/**
 * Filter to grant-making organizations only (true) or non-grant entities only (false). Omit for all.
 */
issuesGrants?: boolean;
/**
 * Filter to organizations that make PRIs (true) or do not (false). Omit for all.
 */
makesPris?: boolean;
/**
 * Filter to direct child organizations of the given parent.
 */
parentOrganizationId?: string;
/**
 * Rollup presence filter on lifetime giving (`has` = >0, `blank` = none). Only meaningful for issuesGrants=true.
 */
lifetimeGivingPresence?: ListOrganizationsLifetimeGivingPresence;
/**
 * Rollup presence filter on open opportunity count (`has` = >0, `blank` = none).
 */
openAsksPresence?: ListOrganizationsOpenAsksPresence;
/**
 * Presence filter on primary contact (`has` = set, `blank` = none).
 */
primaryContactPresence?: ListOrganizationsPrimaryContactPresence;
entityType?: string[];
activeStatus?: string[];
connectionStatus?: string[];
enthusiasm?: string[];
strategicAlignment?: string[];
capacityRating?: string[];
ownerUserId?: string[];
/**
 * Filter to organizations whose `priority` tier is in the given set
(top/high/medium/low). Multi-value: repeat or comma-separate.
Accepts the literal `__blank__` to match rows with no priority set.

 */
priority?: string[];
/**
 * Filter to organizations whose `regionIds` array overlaps the given set.
Multi-value: repeat or comma-separate.

 */
regionIds?: string[];
/**
 * Filter to organizations whose `interestsThematic` array overlaps the
given set (OR semantics). Multi-value: repeat or comma-separate.

 */
interestsThematic?: string[];
type?: string[];
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListOrganizationsLifetimeGivingPresence = typeof ListOrganizationsLifetimeGivingPresence[keyof typeof ListOrganizationsLifetimeGivingPresence];


export const ListOrganizationsLifetimeGivingPresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListOrganizationsOpenAsksPresence = typeof ListOrganizationsOpenAsksPresence[keyof typeof ListOrganizationsOpenAsksPresence];


export const ListOrganizationsOpenAsksPresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListOrganizationsPrimaryContactPresence = typeof ListOrganizationsPrimaryContactPresence[keyof typeof ListOrganizationsPrimaryContactPresence];


export const ListOrganizationsPrimaryContactPresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListPaymentIntermediariesParams = {
search?: string;
type?: PaymentIntermediaryType;
/**
 * Admin-only: when true, include archived (soft-deleted) rows. Ignored for non-admins — they never see archived rows even if this is passed.
 */
includeArchived?: IncludeArchivedQueryParameter;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListHouseholdsParams = {
/**
 * Admin-only: when true, include archived (soft-deleted) rows. Ignored for non-admins — they never see archived rows even if this is passed.
 */
includeArchived?: IncludeArchivedQueryParameter;
search?: string;
active?: boolean;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ExportPeopleCsvParams = {
fields?: string;
};

export type ExportOrganizationsCsvParams = {
fields?: string;
};

export type ExportOpportunitiesAndPledgesCsvParams = {
fields?: string;
};

export type ExportGiftsAndPaymentsCsvParams = {
fields?: string;
};

export type ListPeopleParams = {
/**
 * Admin-only: when true, include archived (soft-deleted) rows. Ignored for non-admins — they never see archived rows even if this is passed.
 */
includeArchived?: IncludeArchivedQueryParameter;
search?: string;
deceased?: boolean;
/**
 * When `false`, exclude people who hold a current role at the Wildflower Foundation organization (internal staff / "foundation partners"). Omit or `true` to include everyone.
 */
showFoundationPartners?: boolean;
regionId?: string;
/**
 * Rollup presence filter on lifetime giving (`has` = >0, `blank` = none).
 */
lifetimeGivingPresence?: ListPeopleLifetimeGivingPresence;
/**
 * Rollup presence filter on most-recent gift date (`has` = any gift, `blank` = none).
 */
lastGiftPresence?: ListPeopleLastGiftPresence;
/**
 * Rollup presence filter on open opportunity count (`has` = >0, `blank` = none).
 */
openAsksPresence?: ListPeopleOpenAsksPresence;
/**
 * Presence filter on current funder/organization roles (`has` = any current role, `blank` = none).
 */
activeAffiliationPresence?: ListPeopleActiveAffiliationPresence;
/**
 * Presence filter on last contacted date (`has` = set, `blank` = null).
 */
lastContactedPresence?: ListPeopleLastContactedPresence;
/**
 * Filter to people by derived newsletter status. Multi-value
(OR semantics): repeat or comma-separate. `subscribed` =
newsletter on and not unsubscribed; `unsubscribed` =
unsubscribed flag set (wins over newsletter); `not_subscribed`
= newsletter off and not unsubscribed.

 */
newsletterStatus?: ListPeopleNewsletterStatusItem[];
/**
 * Capacity-rating slugs (see CapacityRating). Accepts the
literal `__blank__` to match rows with no capacity rating set.

 */
capacityRating?: string[];
/**
 * Connection-status slugs (see ConnectionStatus). Accepts the
literal `__blank__` to match rows with no connection status set.

 */
connectionStatus?: string[];
enthusiasm?: string[];
/**
 * Owner user-id values. Accepts the literal `__blank__` to match
rows with no owner assigned.

 */
ownerUserId?: string[];
/**
 * Filter to people whose `priority` tier is in the given set
(top/high/medium/low). Multi-value: repeat or comma-separate.
Accepts the literal `__blank__` to match rows with no priority set.

 */
priority?: string[];
/**
 * Filter to people whose `regionIds` array overlaps the given set
(any selected region appears in the person's regions). Multi-value:
repeat or comma-separate. Distinct from `regionId` which filters
on `currentHomeRegionId`.

 */
regionIds?: string[];
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListPeopleLifetimeGivingPresence = typeof ListPeopleLifetimeGivingPresence[keyof typeof ListPeopleLifetimeGivingPresence];


export const ListPeopleLifetimeGivingPresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListPeopleLastGiftPresence = typeof ListPeopleLastGiftPresence[keyof typeof ListPeopleLastGiftPresence];


export const ListPeopleLastGiftPresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListPeopleOpenAsksPresence = typeof ListPeopleOpenAsksPresence[keyof typeof ListPeopleOpenAsksPresence];


export const ListPeopleOpenAsksPresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListPeopleActiveAffiliationPresence = typeof ListPeopleActiveAffiliationPresence[keyof typeof ListPeopleActiveAffiliationPresence];


export const ListPeopleActiveAffiliationPresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListPeopleLastContactedPresence = typeof ListPeopleLastContactedPresence[keyof typeof ListPeopleLastContactedPresence];


export const ListPeopleLastContactedPresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListPeopleNewsletterStatusItem = typeof ListPeopleNewsletterStatusItem[keyof typeof ListPeopleNewsletterStatusItem];


export const ListPeopleNewsletterStatusItem = {
  subscribed: 'subscribed',
  unsubscribed: 'unsubscribed',
  not_subscribed: 'not_subscribed',
} as const;

export type ListPeopleEntityRolesParams = {
personId?: string;
organizationId?: string;
paymentIntermediaryId?: string;
householdId?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListDonorPaymentIntermediariesParams = {
organizationId?: string;
individualGiverPersonId?: string;
householdId?: string;
};

export type ListEmailsParams = {
/**
 * Exact address lookup (case-insensitive). Used to preflight 'is this address already on file' before creating a person from a correspondent.
 */
email?: string;
personId?: string;
organizationId?: string;
paymentIntermediaryId?: string;
householdId?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListPhoneNumbersParams = {
personId?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListAddressesParams = {
personId?: string;
organizationId?: string;
paymentIntermediaryId?: string;
householdId?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListOpportunitiesAndPledgesParams = {
/**
 * Admin-only: when true, include archived (soft-deleted) rows. Ignored for non-admins — they never see archived rows even if this is passed.
 */
includeArchived?: IncludeArchivedQueryParameter;
/**
 * Tokenized case-insensitive search: every whitespace-separated word must match the record name or donor display name (org / household / individual). Word order and connector words (e.g. 'and') don't matter.
 */
search?: string;
/**
 * Rollup presence filter on paid amount (`has` = >0, `blank` = none).
 */
paidPresence?: ListOpportunitiesAndPledgesPaidPresence;
/**
 * Presence filter on covered fiscal years (`has` = any, `blank` = none).
 */
coveredFysPresence?: ListOpportunitiesAndPledgesCoveredFysPresence;
/**
 * Presence filter on linked entities (`has` = any allocation, `blank` = none).
 */
entitiesPresence?: ListOpportunitiesAndPledgesEntitiesPresence;
/**
 * Presence filter on projected close date (`has` = set, `blank` = null).
 */
projectedCloseDatePresence?: ListOpportunitiesAndPledgesProjectedCloseDatePresence;
/**
 * Presence filter on application deadline (`has` = set, `blank` = null).
 */
applicationDeadlinePresence?: ListOpportunitiesAndPledgesApplicationDeadlinePresence;
/**
 * Presence filter on win probability (`has` = set, `blank` = null).
 */
winProbabilityPresence?: ListOpportunitiesAndPledgesWinProbabilityPresence;
status?: string[];
stage?: string[];
/**
 * Convenience filter encoding the page split:
  pledges       — writtenPledge=true (the sticky commitment outcome).
                  Drives the /pledges page; historical pledges stay
                  after they're fully paid.
  opportunities — the complement (rest of the rows). Drives the
                  /opportunities page.
Omit to include all rows.

 */
pledgeView?: ListOpportunitiesAndPledgesPledgeView;
/**
 * Filter strictly on the written_pledge column.
 */
writtenPledge?: boolean;
/**
 * Donor-lifecycle worklist preset ("what hasn't been done yet"). Each
value applies a composite server-side filter on top of any other
filters (status, owner, entity scope, etc.) and is the canonical,
drift-proof definition shared with the dashboard worklist counts:
  verbal_no_letter — stage=verbal_confirmation, written_pledge=false,
                     grant_letter_url IS NULL, status=open. A verbal
                     yes with no recorded written commitment yet.
                     Rows are ordered stalest-first (least recently
                     updated) so the oldest sit at the top.
  committed_unpaid — status=pledge with $0 received. A written pledge
                     nothing has been paid against yet.
  partially_paid   — status=pledge with >$0 received (a pledge fully
                     paid flips to cash_in, so status=pledge + paid>0
                     means paid < awarded). No expected-payment-date
                     field exists, so rows are ordered by projected
                     close date (oldest first) as a best-effort
                     "overdue" proxy.

 */
worklist?: ListOpportunitiesAndPledgesWorklist;
type?: string[];
organizationId?: string;
householdId?: string;
individualGiverPersonId?: string;
ownerUserId?: string[];
/**
 * Filter to opportunities that have at least one pledge_allocation
with `entity_id` in the given set. Comma-separated form supported.

 */
entityId?: string[];
/**
 * Filter to opportunities that have at least one pledge_allocation
with `grant_year` in the given set (e.g. `fy2026`). Multi-value:
repeat the param or comma-separate. Omit to include all fiscal
years.

 */
fiscalYear?: string[];
/**
 * Filter to opportunities/pledges that have at least one pledge_allocation
with fundable_project_id in the given set. Comma-separated form supported.

 */
fundableProjectId?: string[];
/**
 * When true, the response includes `stageAskTotals` — SUM(ask_amount)
per stage over ALL rows matching the filters, not just the
returned page. Used by the pipeline board so column totals stay
correct when the result set exceeds the page limit.

 */
includeStageAskTotals?: boolean;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListOpportunitiesAndPledgesPaidPresence = typeof ListOpportunitiesAndPledgesPaidPresence[keyof typeof ListOpportunitiesAndPledgesPaidPresence];


export const ListOpportunitiesAndPledgesPaidPresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListOpportunitiesAndPledgesCoveredFysPresence = typeof ListOpportunitiesAndPledgesCoveredFysPresence[keyof typeof ListOpportunitiesAndPledgesCoveredFysPresence];


export const ListOpportunitiesAndPledgesCoveredFysPresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListOpportunitiesAndPledgesEntitiesPresence = typeof ListOpportunitiesAndPledgesEntitiesPresence[keyof typeof ListOpportunitiesAndPledgesEntitiesPresence];


export const ListOpportunitiesAndPledgesEntitiesPresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListOpportunitiesAndPledgesProjectedCloseDatePresence = typeof ListOpportunitiesAndPledgesProjectedCloseDatePresence[keyof typeof ListOpportunitiesAndPledgesProjectedCloseDatePresence];


export const ListOpportunitiesAndPledgesProjectedCloseDatePresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListOpportunitiesAndPledgesApplicationDeadlinePresence = typeof ListOpportunitiesAndPledgesApplicationDeadlinePresence[keyof typeof ListOpportunitiesAndPledgesApplicationDeadlinePresence];


export const ListOpportunitiesAndPledgesApplicationDeadlinePresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListOpportunitiesAndPledgesWinProbabilityPresence = typeof ListOpportunitiesAndPledgesWinProbabilityPresence[keyof typeof ListOpportunitiesAndPledgesWinProbabilityPresence];


export const ListOpportunitiesAndPledgesWinProbabilityPresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListOpportunitiesAndPledgesPledgeView = typeof ListOpportunitiesAndPledgesPledgeView[keyof typeof ListOpportunitiesAndPledgesPledgeView];


export const ListOpportunitiesAndPledgesPledgeView = {
  pledges: 'pledges',
  opportunities: 'opportunities',
} as const;

export type ListOpportunitiesAndPledgesWorklist = typeof ListOpportunitiesAndPledgesWorklist[keyof typeof ListOpportunitiesAndPledgesWorklist];


export const ListOpportunitiesAndPledgesWorklist = {
  verbal_no_letter: 'verbal_no_letter',
  committed_unpaid: 'committed_unpaid',
  partially_paid: 'partially_paid',
} as const;

export type ListPledgeAllocationsParams = {
pledgeOrOpportunityId?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListPledgeExpectedPaymentsParams = {
pledgeOrOpportunityId?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListGiftsAndPaymentsParams = {
/**
 * Admin-only: when true, include archived (soft-deleted) rows. Ignored for non-admins — they never see archived rows even if this is passed.
 */
includeArchived?: IncludeArchivedQueryParameter;
/**
 * Tokenized case-insensitive search: every whitespace-separated word must match the record name, donor display name (org / household / individual), or linked payment-intermediary name. Word order and connector words (e.g. 'and') don't matter.
 */
search?: string;
/**
 * Presence filter on linked entities (`has` = any allocation, `blank` = none).
 */
entitiesPresence?: ListGiftsAndPaymentsEntitiesPresence;
/**
 * Presence filter on display usages (`has` = any, `blank` = none).
 */
usagesPresence?: ListGiftsAndPaymentsUsagesPresence;
/**
 * Presence filter on grant years (`has` = any, `blank` = none).
 */
grantYearsPresence?: ListGiftsAndPaymentsGrantYearsPresence;
type?: string[];
organizationId?: string;
householdId?: string;
individualGiverPersonId?: string;
opportunityId?: string;
paymentMethod?: string[];
/**
 * Presence filter on thank-you sent date (`has` = sent, `blank` = not sent).
 */
thankYouSentAtPresence?: ListGiftsAndPaymentsThankYouSentAtPresence;
/**
 * Presence filter on date received (`has` = set, `blank` = null).
 */
dateReceivedPresence?: ListGiftsAndPaymentsDateReceivedPresence;
/**
 * Presence filter on purpose verbatim notes across allocations (`has` = any allocation has one, `blank` = none).
 */
purposeVerbatimPresence?: ListGiftsAndPaymentsPurposeVerbatimPresence;
/**
 * Filter by restriction summary label (OR semantics). `restricted` = at least one allocation has a donor-restricted axis (regional/usage/time), a fundable project, or an entity other than wildflower_foundation; `unrestricted` = none of those conditions hold on any allocation.
 */
restrictionLabels?: ListGiftsAndPaymentsRestrictionLabelsItem[];
/**
 * Filter to gifts with at least one allocation whose regional_restriction_type is in the given set (OR). Repeat or comma-separate.
 */
regionalRestrictionTypes?: RestrictionAxis[];
/**
 * Filter to gifts with at least one allocation whose other_restriction_type is in the given set (OR). Repeat or comma-separate.
 */
otherRestrictionTypes?: RestrictionAxis[];
/**
 * Filter to gifts with at least one allocation whose time_restriction_type is in the given set (OR). Repeat or comma-separate.
 */
timeRestrictionTypes?: RestrictionAxis[];
ownerUserId?: string[];
/**
 * Filter to gifts that have at least one gift_allocation with `entity_id`
in the given set. Comma-separated form supported.

 */
entityId?: string[];
/**
 * Filter to gifts that have at least one gift_allocation with
`grant_year` in the given set (e.g. `fy2026`). Multi-value:
repeat the param or comma-separate. Omit to include all
fiscal years.

 */
fiscalYear?: string[];
/**
 * Filter to gifts that have at least one gift_allocation with
fundable_project_id in the given set. Comma-separated form supported.

 */
fundableProjectId?: string[];
/**
 * Keep gifts with dateReceived on/after this date (inclusive).
 */
dateAfter?: string;
/**
 * Keep gifts with dateReceived on/before this date (inclusive).
 */
dateBefore?: string;
/**
 * Exact gift amount (major units) to filter by, e.g. `480` or `480.00`. Numeric-equality match on the gift's `amount`; non-numeric values are ignored.
 */
amount?: string;
/**
 * Filter by whether a QuickBooks staged payment is reconciled to / created this gift (`linked`) or not (`unlinked`).
 */
linkedToQuickbooks?: ListGiftsAndPaymentsLinkedToQuickbooks;
/**
 * Filter on the derived per-gift QuickBooks-tie status. Repeat or
comma-separate for multiple values. The special value `untied`
(sugar for `missing` + `amount_mismatch`) lists on-books gifts that
should tie to a QuickBooks record but don't.

 */
quickbooksTie?: ListGiftsAndPaymentsQuickbooksTieItem[];
/**
 * When true, list only gifts awaiting funding evidence (edge case B4): CRM-first gifts logged by a fundraiser before any funding evidence arrived. Answered entirely from the ledger-derived tie: `quickbooksTieStatus = missing` (no counted payment-application row from any source). Off-books/exempt and processor-sourced (tied) gifts are excluded.
 */
awaitingEvidence?: boolean;
/**
 * When true, list only gifts with no canonical `payment_units.gift_id` owner. This powers Browse unlinked CRM gifts and is intentionally independent of QuickBooks tie status: a gift linked to bank or Stripe payment evidence but still missing downstream QBO documentation is linked and must not appear here.
 */
unlinkedToPaymentUnit?: boolean;
/**
 * Donor-lifecycle worklist preset ("what hasn't been done yet"), the
canonical definition shared with the dashboard worklist counts:
  missing_allocations — gift headers with no gift_allocations rows
                        at all. ALL money scope (entity, fiscal year,
                        sub-amounts, coding) lives on allocation rows,
                        so a gift with none is uncoded/unattributed
                        and needs allocation work.

 */
worklist?: ListGiftsAndPaymentsWorklist;
/**
 * When true, return only gifts backed by a Donorbox donation (same authority as the Donorbox badge).
 */
donorboxBacked?: boolean;
/**
 * When true, return only gifts that have an APPLIED Donation Revenue Coding Form row matched to them.
 */
codingForm?: boolean;
/**
 * Filter to gifts whose campaign_slug is in the given set (OR). Repeat or comma-separate.
 */
campaignSlugs?: string[];
/**
 * Sort order (default date_desc).
 */
sort?: GiftSort;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListGiftsAndPaymentsEntitiesPresence = typeof ListGiftsAndPaymentsEntitiesPresence[keyof typeof ListGiftsAndPaymentsEntitiesPresence];


export const ListGiftsAndPaymentsEntitiesPresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListGiftsAndPaymentsUsagesPresence = typeof ListGiftsAndPaymentsUsagesPresence[keyof typeof ListGiftsAndPaymentsUsagesPresence];


export const ListGiftsAndPaymentsUsagesPresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListGiftsAndPaymentsGrantYearsPresence = typeof ListGiftsAndPaymentsGrantYearsPresence[keyof typeof ListGiftsAndPaymentsGrantYearsPresence];


export const ListGiftsAndPaymentsGrantYearsPresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListGiftsAndPaymentsThankYouSentAtPresence = typeof ListGiftsAndPaymentsThankYouSentAtPresence[keyof typeof ListGiftsAndPaymentsThankYouSentAtPresence];


export const ListGiftsAndPaymentsThankYouSentAtPresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListGiftsAndPaymentsDateReceivedPresence = typeof ListGiftsAndPaymentsDateReceivedPresence[keyof typeof ListGiftsAndPaymentsDateReceivedPresence];


export const ListGiftsAndPaymentsDateReceivedPresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListGiftsAndPaymentsPurposeVerbatimPresence = typeof ListGiftsAndPaymentsPurposeVerbatimPresence[keyof typeof ListGiftsAndPaymentsPurposeVerbatimPresence];


export const ListGiftsAndPaymentsPurposeVerbatimPresence = {
  has: 'has',
  blank: 'blank',
} as const;

export type ListGiftsAndPaymentsRestrictionLabelsItem = typeof ListGiftsAndPaymentsRestrictionLabelsItem[keyof typeof ListGiftsAndPaymentsRestrictionLabelsItem];


export const ListGiftsAndPaymentsRestrictionLabelsItem = {
  restricted: 'restricted',
  unrestricted: 'unrestricted',
} as const;

export type ListGiftsAndPaymentsLinkedToQuickbooks = typeof ListGiftsAndPaymentsLinkedToQuickbooks[keyof typeof ListGiftsAndPaymentsLinkedToQuickbooks];


export const ListGiftsAndPaymentsLinkedToQuickbooks = {
  linked: 'linked',
  unlinked: 'unlinked',
} as const;

export type ListGiftsAndPaymentsQuickbooksTieItem = typeof ListGiftsAndPaymentsQuickbooksTieItem[keyof typeof ListGiftsAndPaymentsQuickbooksTieItem];


export const ListGiftsAndPaymentsQuickbooksTieItem = {
  exempt: 'exempt',
  tied: 'tied',
  amount_mismatch: 'amount_mismatch',
  missing: 'missing',
  untied: 'untied',
} as const;

export type ListGiftsAndPaymentsWorklist = typeof ListGiftsAndPaymentsWorklist[keyof typeof ListGiftsAndPaymentsWorklist];


export const ListGiftsAndPaymentsWorklist = {
  missing_allocations: 'missing_allocations',
} as const;

export type ListGiftAllocationsParams = {
giftId?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListRestrictionTextReviewParams = {
/**
 * Restrict to gift or pledge allocations. Omit for both.
 */
source?: ListRestrictionTextReviewSource;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListRestrictionTextReviewSource = typeof ListRestrictionTextReviewSource[keyof typeof ListRestrictionTextReviewSource];


export const ListRestrictionTextReviewSource = {
  gift: 'gift',
  pledge: 'pledge',
} as const;

export type GetRevenueExtractorReportParams = {
/**
 * Inclusive lower bound on gift date_received (YYYY-MM-DD).
 */
startDate: string;
/**
 * Inclusive upper bound on gift date_received (YYYY-MM-DD).
 */
endDate: string;
};

export type ListInteractionsParams = {
search?: string;
personId?: string;
organizationId?: string;
/**
 * With organizationId, also include interactions linked to people who hold a current role at that organization.
 */
includeLinkedPeople?: boolean;
householdId?: string;
ownerUserId?: string[];
kind?: InteractionKind[];
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListNotesParams = {
search?: string;
personId?: string;
organizationId?: string;
householdId?: string;
opportunityId?: string;
giftId?: string;
/**
 * Filter to notes mentioning this user.
 */
mentionUserId?: string;
authorUserId?: string;
/**
 * Filter to free-form notes linked to this physical calendar meeting.
 */
calendarEventId?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListMediaMentionsParams = {
search?: string;
personId?: string;
organizationId?: string;
/**
 * With organizationId, also include media mentions linked to people who hold a current role at that organization.
 */
includeLinkedPeople?: boolean;
/**
 * Filter to pinned (true) or unpinned (false) mentions.
 */
pinned?: boolean;
/**
 * Include duplicate and low-confidence historical mentions hidden by the read-time quality filter.
 */
includeHidden?: boolean;
/**
 * Include media mentions hidden by persisted relevance filtering. Pinned mentions are always returned.
 */
includeFiltered?: boolean;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListTasksParams = {
search?: string;
personId?: string;
organizationId?: string;
householdId?: string;
opportunityId?: string;
/**
 * Filter to tasks linked to an opportunity/pledge whose donor is this organization (e.g. reporting deadlines by donor).
 */
opportunityOrganizationId?: string;
/**
 * Filter to tasks linked to an opportunity/pledge whose donor is this household.
 */
opportunityHouseholdId?: string;
/**
 * Filter to tasks linked to an opportunity/pledge whose donor is this individual.
 */
opportunityIndividualGiverPersonId?: string;
giftId?: string;
grantLeadId?: string;
mentionUserId?: string;
assigneeUserId?: string;
createdByUserId?: string;
kind?: TaskKind[];
status?: TaskStatus[];
/**
 * Inclusive upper bound on due_date.
 */
dueBefore?: string;
/**
 * Inclusive lower bound on due_date.
 */
dueAfter?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListMeetingNotesParams = {
personId?: string;
organizationId?: string;
/**
 * With organizationId, also include meeting notes linked to people who hold a current role at that organization.
 */
includeLinkedPeople?: boolean;
householdId?: string;
creatorUserId?: string;
calendarEventId?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListSavedViewsParams = {
/**
 * Page identifier, e.g. 'individuals', 'funders'.
 */
listKey: string;
};

export type ListTrackedEmailsParams = {
/**
 * @minimum 1
 * @maximum 1000
 */
limit?: number;
};

export type ListTrackedOutboundQueueParams = {
allMailboxes?: boolean;
};

export type ListTrackedInboundQueueParams = {
allMailboxes?: boolean;
};

export type SearchTrackedEmailParams = {
subject: string;
};

export type ListTrackedEmailsByContactParams = {
personId?: string;
organizationId?: string;
householdId?: string;
};

export type DeleteLatestTrackedEmailView200 = {
  deleted: number;
};

export type ListEmailMessagesParams = {
search?: string;
mailboxUserId?: string;
personId?: string;
organizationId?: string;
/**
 * With organizationId, also include email messages matched to people who hold a current role at that organization.
 */
includeLinkedPeople?: boolean;
householdId?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListTripPlansParams = {
travelerUserId?: string;
startAfter?: string;
startBefore?: string;
/**
 * Admin-only: when true, include archived (soft-deleted) rows. Ignored for non-admins — they never see archived rows even if this is passed.
 */
includeArchived?: IncludeArchivedQueryParameter;
};

export type ListCalendarEventsParams = {
search?: string;
calendarUserId?: string;
personId?: string;
organizationId?: string;
/**
 * With organizationId, also include calendar events matched to people who hold a current role at that organization.
 */
includeLinkedPeople?: boolean;
householdId?: string;
/**
 * Exclude physical meetings a CRM user marked as not needing notes.
 */
excludeNotesNotNeeded?: boolean;
/**
 * Only events with startAt >= this timestamp.
 */
startAfter?: string;
/**
 * Only events with startAt < this timestamp.
 */
startBefore?: string;
/**
 * Sort by startAt. Default desc (most recent first).
 */
order?: ListCalendarEventsOrder;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListCalendarEventsOrder = typeof ListCalendarEventsOrder[keyof typeof ListCalendarEventsOrder];


export const ListCalendarEventsOrder = {
  asc: 'asc',
  desc: 'desc',
} as const;

export type AdminResyncGoogleUser200 = { [key: string]: unknown };

export type DisconnectGoogleOauth200 = {
  ok: boolean;
};

export type DisconnectQuickbooksOauth200 = {
  ok: boolean;
};

export type ListStripeStagedChargesParams = {
/**
 * Which queue to list (default needs_review).
 */
queue?: StagedPaymentQueue;
/**
 * Sort order (default date_desc).
 */
sort?: StagedPaymentSort;
/**
 * Free-text filter across payer name/email, description, and statement descriptor.
 */
search?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListDonorboxReviewParams = {
/**
 * Which worklist bucket to list (default needs_review).
 */
queue?: DonorboxReviewQueue;
/**
 * Free-text filter across donor name/email, comment, designation, and campaign.
 */
search?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListStripePayoutReconciliationsParams = {
/**
 * Which queue to list (default all).
 */
queue?: StripePayoutReconciliationQueue;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type AdminDeleteQuickbooksRule200 = {
  ok: boolean;
};

export type ListRevenueAccountsParams = {
/**
 * When true, omit deactivated accounts.
 */
activeOnly?: boolean;
};

export type AdminDeleteEntityCodingRule200 = {
  ok: boolean;
};

export type ListStagedPaymentsParams = {
/**
 * Which queue to list (default needs_review).
 */
queue?: QuickbooksStagedPaymentQueue;
/**
 * Sort order (default date_desc).
 */
sort?: StagedPaymentSort;
/**
 * Free-text filter across payer, memo, and line item / account / class detail.
 */
search?: string;
/**
 * Restrict to one Wildflower entity (entities.id). Empty or 'all' = no restriction; the Foundation id also includes unattributed (null-entity) rows.
 */
entity?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type SearchStagedPaymentDonorsParams = {
/**
 * Search query (min 2 chars).
 */
q: string;
};

export type GetPendingStagedMoneyForDonorParams = {
/**
 * Donor kind.
 */
donorType: GetPendingStagedMoneyForDonorDonorType;
/**
 * Donor record id.
 */
donorId: string;
};

export type GetPendingStagedMoneyForDonorDonorType = typeof GetPendingStagedMoneyForDonorDonorType[keyof typeof GetPendingStagedMoneyForDonorDonorType];


export const GetPendingStagedMoneyForDonorDonorType = {
  organization: 'organization',
  individual: 'individual',
  household: 'household',
} as const;

export type ListStagedPaymentGiftWindowParams = {
/**
 * ± days around the staged date (default 30).
 * @minimum 1
 * @maximum 365
 */
days?: number;
};

export type ListGrantLeadsParams = {
/**
 * Filter by status. Omit to get all active (new + claimed) leads.
 */
status?: GrantLeadStatus;
/**
 * Filter by assignee.
 */
assigneeUserId?: string;
/**
 * Free-text filter across title and funder name.
 */
search?: string;
/**
 * When true, include archived and converted leads.
 */
includeArchived?: boolean;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type GetDashboardSummaryParams = {
/**
 * Optional list of `entities.id` slugs. When provided, the money tiles
(received / openPipelineAsk / openPipelineWeighted / goal) are restricted
to allocations on those entities. Counts are unaffected. Omit or pass an
empty list to include all entities.

 */
entityIds?: string[];
};

export type GetProjectionsByFyEntityParams = {
/**
 * Optional set of `entities.id` slugs. When provided, only allocations
on those entities are included. Comma-separated form supported.

 */
entityId?: string[];
};

export type GetFiscalYearBreakdownParams = {
/**
 * Optional `entities.id` slug. When provided, both the `received` and
`openPipeline` sections are restricted to allocations on that entity.
Omit to include all entities.

 */
entityId?: string;
};

export type GetFiscalYearReportParams = {
/**
 * Which track to report — `revenue` (Grants) or `loan_capital` (Loans). Defaults to revenue.
 */
category?: FundraisingCategory;
/**
 * Optional list of `entities.id` slugs. When provided, all three buckets
and the goal are restricted to allocations on those entities. Omit or
pass an empty list to include all entities.

 */
entityIds?: string[];
};

export type RequestUploadUrlBody = {
  /** @minLength 1 */
  name: string;
  /** @minimum 1 */
  size: number;
  /** @minLength 1 */
  contentType: string;
};

export type RequestUploadUrl200Metadata = {
  name?: string;
  size?: number;
  contentType?: string;
};

export type RequestUploadUrl200 = {
  uploadURL: string;
  objectPath: string;
  metadata?: RequestUploadUrl200Metadata;
};

export type ListPersonSuppressionWindowsParams = {
/**
 * Filter to a specific person.
 */
personId?: string;
};

export type ListAuditLogParams = {
/**
 * Filter to one entity type (e.g. person, organization).
 */
entityType?: string;
/**
 * Filter to a single entity's timeline (usually paired with entityType).
 */
entityId?: string;
/**
 * Filter to actions taken by one user.
 */
actorUserId?: string;
/**
 * Filter to one action (create/update/archive/unarchive/merge/bulk_update/bulk_archive).
 */
action?: string;
/**
 * Case-insensitive partial match across the entry summary, the actor's name/email, and the recorded field changes.
 */
search?: string;
/**
 * Inclusive lower bound — only entries on or after the start of this America/Chicago calendar day.
 */
dateFrom?: string;
/**
 * Inclusive upper bound — only entries on or before the end of this America/Chicago calendar day.
 */
dateTo?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type GetOwnedRecordCountsParams = {
/**
 * The user whose owned records to count.
 */
userId: string;
};

export type ListReconciliationCardsParams = {
/**
 * Queue bucket to list. Omit for the active work queue (excludes match_confirmed/excluded rows AND parks pending fiscally-sponsored money out of the main flow). Request queue=fiscally_sponsored to view the parked queue (still fully matchable).
 */
queue?: ReconciliationCardQueue;
/**
 * Free-text over payer name / reference / memo.
 */
q?: string;
/**
 * Filter to one Wildflower legal entity attribution.
 */
entityId?: string;
/**
 * Filter to cards whose auto-proposal passes (true) / fails (false) the consistency gate.
 */
ready?: boolean;
/**
 * Filter the Excluded queue to a single exclusion reason. Only meaningful with queue=excluded; ignored otherwise.
 */
exclusionReason?: StagedPaymentExclusionReason;
/**
 * Filter cards by funding source (Gift report §4.5): stripe / donorbox / qb_direct (checks, ACH, cash — money not routed through a processor, including unclassified). Applies across all queues.
 */
fundingSource?: ListReconciliationCardsFundingSource;
/**
 * @minimum 1
 * @maximum 500
 */
limit?: number;
/**
 * @minimum 0
 */
offset?: number;
};

export type ListReconciliationCardsFundingSource = typeof ListReconciliationCardsFundingSource[keyof typeof ListReconciliationCardsFundingSource];


export const ListReconciliationCardsFundingSource = {
  stripe: 'stripe',
  donorbox: 'donorbox',
  qb_direct: 'qb_direct',
} as const;

export type SearchReconciliationNodeParams = {
/**
 * QuickBooks card anchor; scopes amount/date windows and cross-filtering. Provide exactly one of stagedPaymentId or stripeChargeId.
 */
stagedPaymentId?: string;
/**
 * Stripe charge anchor (its GROSS amount + date scope the window); for donor/gift search on a charge that has no staged payment. Provide exactly one of stagedPaymentId or stripeChargeId.
 */
stripeChargeId?: string;
/**
 * Free-text query (donor/gift name, payer, reference).
 */
q?: string;
/**
 * Cross-filter gift/opportunity candidates to this donor (FILTER edge).
 */
donorId?: string;
/**
 * Split mode (gift search only): candidate gifts are FRACTIONS of the payment, not near-equal to it. Drops the lower amount bound (returns gifts with amount > 0 up to the payment total within fee-band tolerance), relaxes the date window, and orders by date proximity/recency instead of proximity to the full amount.
 */
split?: boolean;
/**
 * ± days around the anchor date for amount/date windows.
 * @minimum 1
 * @maximum 365
 */
days?: number;
/**
 * @minimum 1
 * @maximum 100
 */
limit?: number;
};

export type SearchReconciliationQbStagedParams = {
/**
 * Free-text over payer name / reference / memo / doc number (for Stripe: payer name / email / description / statement descriptor).
 */
q?: string;
/**
 * Target amount (major units); when set, results are scored/filtered around it.
 */
amount?: string;
/**
 * Anchor date; pair with days for a ± window.
 */
date?: string;
/**
 * ± days around date for the amount/date window.
 * @minimum 1
 * @maximum 365
 */
days?: number;
/**
 * @minimum 1
 * @maximum 100
 */
limit?: number;
/**
 * Also search Stripe staged charges and interleave them with the QB rows by amount/date proximity (nodeType=stripe). Default false: QB-only, preserving existing callers.
 */
includeStripe?: boolean;
};

export type SearchReconciliationPayoutsParams = {
/**
 * Free-text over the Stripe payout id (po_...).
 */
q?: string;
/**
 * Target amount (major units); when set, results are banded around the payout net.
 */
amount?: string;
/**
 * Anchor date; pair with days for a ± window.
 */
date?: string;
/**
 * ± days around date for the amount/date window.
 * @minimum 1
 * @maximum 365
 */
days?: number;
/**
 * @minimum 1
 * @maximum 100
 */
limit?: number;
};

export type ListDepositCandidatePayouts200 = {
  data: DepositCandidatePayout[];
};

export type ListDepositCandidatePaymentUnitsParams = {
/**
 * Target amount in major units; results are ordered by proximity but not filtered by proximity.
 */
amount?: string;
/**
 * Optional text over payer, memo, amount, date, source label, or payment-unit id.
 */
q?: string;
/**
 * Optional exact payment-unit amount in major units.
 */
filterAmount?: string;
/**
 * Optional exact payment-unit received date.
 */
filterDate?: string;
/**
 * @minimum 1
 * @maximum 100
 */
limit?: number;
};

export type AbsorbBankDepositComponentRemainder200 = {
  id: string;
  paymentUnitId: string;
  amount: string;
};

export type LinkPayoutDepositBody = {
  bankDepositId: string;
};

export type ListPayoutCandidateDeposits200 = {
  data: PayoutCandidateDeposit[];
};

export type ListGiftsMissingQbParams = {
/**
 * Free-text over donor name (organization / person / household) or the CRM gift name. When set, the response ALSO carries `linkedMatches`: gifts matching the text that are excluded from the list because they are already tied to money, so a search never silently hides an already-matched gift.
 */
q?: string;
/**
 * Filter to one Wildflower legal entity.
 */
entityId?: string;
/**
 * Filter to one recorded gift payment method.
 */
paymentMethod?: GiftPaymentMethod;
/**
 * Filter by the source of this gift's best-guess UNLINKED payment proposal (the same match the row's one-click Link surfaces): stripe = only a Stripe charge is plausible; qb_direct = a QuickBooks staged payment is plausible (preferred over Stripe); donorbox = no proposals originate from Donorbox (settles via Stripe), so this always yields none — kept only so the column's filter set matches the other two Gift-report columns.
 */
fundingSource?: ListGiftsMissingQbFundingSource;
dateFrom?: string;
dateTo?: string;
/**
 * @minimum 1
 * @maximum 200
 */
limit?: number;
/**
 * @minimum 0
 */
offset?: number;
};

export type ListGiftsMissingQbFundingSource = typeof ListGiftsMissingQbFundingSource[keyof typeof ListGiftsMissingQbFundingSource];


export const ListGiftsMissingQbFundingSource = {
  stripe: 'stripe',
  donorbox: 'donorbox',
  qb_direct: 'qb_direct',
} as const;

export type ListIncompleteGiftsParams = {
/**
 * Free-text over donor name (organization / person / household).
 */
q?: string;
/**
 * Filter to gifts with an allocation attributed to this Wildflower legal entity.
 */
entityId?: string;
/**
 * @minimum 1
 * @maximum 200
 */
limit?: number;
/**
 * @minimum 0
 */
offset?: number;
};

export type ListReconciliationBundleAnchorsParams = {
/**
 * Which bucket to list (default needs_review).
 */
queue?: BundleAnchorQueue;
/**
 * Restrict to one anchor source. Omit to list both.
 */
source?: BundleAnchorType;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListWorkbenchDepositsParams = {
/**
 * Which deposit lens to list (default all_open).
 */
lens?: WorkbenchDepositLens;
/**
 * Free-text over bank memo/reference/account, payment-unit ids and linked gift names.
 */
q?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListNewsletterContactsParams = {
audience: ListNewsletterContactsAudience;
search?: string;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListNewsletterContactsAudience = typeof ListNewsletterContactsAudience[keyof typeof ListNewsletterContactsAudience];


export const ListNewsletterContactsAudience = {
  current_subscribers: 'current_subscribers',
  linked_current_subscribers: 'linked_current_subscribers',
  unmatched_current_subscribers: 'unmatched_current_subscribers',
  unsubscribe_evidence: 'unsubscribe_evidence',
  bounce_evidence: 'bounce_evidence',
} as const;

export type ListPersonNewsletterEngagementParams = {
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

export type ListNewsletterEngagementParams = {
search?: string;
opened?: boolean;
clicked?: boolean;
linked?: boolean;
/**
 * @minimum 1
 * @maximum 10000
 */
limit?: LimitParameter;
/**
 * @minimum 1
 */
page?: PageParameter;
};

