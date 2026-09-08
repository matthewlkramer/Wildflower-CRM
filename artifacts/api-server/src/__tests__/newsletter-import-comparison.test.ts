import { describe, expect, it } from "vitest";
import {
  compareNewsletterWorkbookToCrm,
  type NewsletterComparisonEmail,
  type NewsletterComparisonPerson,
} from "../lib/newsletterImportComparison";
import type { ParsedNewsletterContact } from "../lib/newsletterWorkbook";

function contact(
  email: string,
  overrides: Partial<ParsedNewsletterContact> = {},
): ParsedNewsletterContact {
  return {
    normalizedEmail: email.toLowerCase(),
    email,
    firstName: null,
    lastName: null,
    sourceCurrentSubscriber: false,
    sourceUnsubscribed: false,
    sourceBounced: false,
    unsubscribeEvidence: [],
    bounceEvidence: [],
    ...overrides,
  };
}

describe("compareNewsletterWorkbookToCrm", () => {
  it("reports status mismatches and exact-name email candidates without inventing ambiguous matches", () => {
    const people: NewsletterComparisonPerson[] = [
      {
        id: "person-active",
        firstName: "Ada",
        lastName: "Lovelace",
        fullName: "Ada Lovelace",
        newsletter: false,
        unsubscribedToNewsletter: false,
      },
      {
        id: "person-unsubscribed",
        firstName: "Grace",
        lastName: "Hopper",
        fullName: "Grace Hopper",
        newsletter: true,
        unsubscribedToNewsletter: false,
      },
      {
        id: "person-email",
        firstName: "Katherine",
        lastName: "Johnson",
        fullName: "Katherine Johnson",
        newsletter: true,
        unsubscribedToNewsletter: false,
      },
      {
        id: "person-duplicate-one",
        firstName: "Alex",
        lastName: "Smith",
        fullName: "Alex Smith",
        newsletter: false,
        unsubscribedToNewsletter: false,
      },
      {
        id: "person-duplicate-two",
        firstName: "Alex",
        lastName: "Smith",
        fullName: "Alex Smith",
        newsletter: false,
        unsubscribedToNewsletter: false,
      },
    ];
    const emails: NewsletterComparisonEmail[] = [
      {
        id: "email-active",
        email: "ada@example.org",
        personId: "person-active",
      },
      {
        id: "email-unsubscribed",
        email: "grace@example.org",
        personId: "person-unsubscribed",
      },
      {
        id: "email-different",
        email: "kjohnson@example.org",
        personId: "person-email",
      },
      {
        id: "email-duplicate-one",
        email: "alex.one@example.org",
        personId: "person-duplicate-one",
      },
      {
        id: "email-duplicate-two",
        email: "alex.two@example.org",
        personId: "person-duplicate-two",
      },
    ];
    const result = compareNewsletterWorkbookToCrm(
      [
        contact("ada@example.org", { sourceCurrentSubscriber: true }),
        contact("grace@example.org", { sourceUnsubscribed: true }),
        contact("katherine@example.org", {
          firstName: "Katherine",
          lastName: "Johnson",
          sourceCurrentSubscriber: true,
        }),
        contact("alex.new@example.org", {
          firstName: "Alex",
          lastName: "Smith",
        }),
      ],
      emails,
      people,
    );

    expect(result.subscriptionDifferences).toEqual([
      {
        personId: "person-active",
        personName: "Ada Lovelace",
        email: "ada@example.org",
        flodeskStatus: "subscribed",
        crmStatus: "not_subscribed",
      },
      {
        personId: "person-unsubscribed",
        personName: "Grace Hopper",
        email: "grace@example.org",
        flodeskStatus: "unsubscribed",
        crmStatus: "subscribed",
      },
    ]);
    expect(result.emailDifferences).toEqual([
      {
        personId: "person-email",
        personName: "Katherine Johnson",
        flodeskEmail: "katherine@example.org",
        crmEmails: ["kjohnson@example.org"],
        matchBasis: "exact_name",
      },
    ]);
  });
});
