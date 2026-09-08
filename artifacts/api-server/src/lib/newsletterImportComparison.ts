import type { ParsedNewsletterContact } from "./newsletterWorkbook";

export interface NewsletterComparisonEmail {
  id: string;
  email: string;
  personId: string | null;
}

export interface NewsletterComparisonPerson {
  id: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  newsletter: boolean;
  unsubscribedToNewsletter: boolean;
}

export interface NewsletterSubscriptionDifference {
  personId: string;
  personName: string;
  email: string;
  flodeskStatus: "subscribed" | "unsubscribed";
  crmStatus: "subscribed" | "unsubscribed" | "not_subscribed";
}

export interface NewsletterEmailDifference {
  personId: string;
  personName: string;
  flodeskEmail: string;
  crmEmails: string[];
  matchBasis: "exact_name";
}

function cleanName(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function displayName(person: NewsletterComparisonPerson): string {
  return (
    cleanName(person.fullName) ||
    cleanName([person.firstName, person.lastName].filter(Boolean).join(" ")) ||
    "Unnamed person"
  );
}

function exactNameKey(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string | null {
  const first = cleanName(firstName);
  const last = cleanName(lastName);
  if (!first || !last) return null;
  return `${first} ${last}`.toLocaleLowerCase("en-US");
}

export function compareNewsletterWorkbookToCrm(
  contacts: ParsedNewsletterContact[],
  crmEmails: NewsletterComparisonEmail[],
  crmPeople: NewsletterComparisonPerson[],
): {
  subscriptionDifferences: NewsletterSubscriptionDifference[];
  emailDifferences: NewsletterEmailDifference[];
} {
  const personById = new Map(crmPeople.map((person) => [person.id, person]));
  const emailByAddress = new Map(
    crmEmails.map((row) => [row.email.trim().toLocaleLowerCase("en-US"), row]),
  );
  const emailsByPerson = new Map<string, string[]>();
  for (const row of crmEmails) {
    if (!row.personId) continue;
    const values = emailsByPerson.get(row.personId) ?? [];
    if (!values.includes(row.email)) values.push(row.email);
    emailsByPerson.set(row.personId, values);
  }

  const peopleByExactName = new Map<string, NewsletterComparisonPerson[]>();
  for (const person of crmPeople) {
    const key = exactNameKey(person.firstName, person.lastName);
    if (!key) continue;
    const matches = peopleByExactName.get(key) ?? [];
    matches.push(person);
    peopleByExactName.set(key, matches);
  }

  const subscriptionDifferences: NewsletterSubscriptionDifference[] = [];
  const emailDifferences: NewsletterEmailDifference[] = [];
  for (const contact of contacts) {
    const exactEmail = emailByAddress.get(contact.normalizedEmail);
    const person = exactEmail?.personId
      ? personById.get(exactEmail.personId)
      : undefined;
    const flodeskStatus = contact.sourceCurrentSubscriber
      ? "subscribed"
      : contact.sourceUnsubscribed
        ? "unsubscribed"
        : null;

    if (person && flodeskStatus) {
      const crmStatus = person.unsubscribedToNewsletter
        ? "unsubscribed"
        : person.newsletter
          ? "subscribed"
          : "not_subscribed";
      if (crmStatus !== flodeskStatus) {
        subscriptionDifferences.push({
          personId: person.id,
          personName: displayName(person),
          email: contact.email,
          flodeskStatus,
          crmStatus,
        });
      }
    }

    if (exactEmail) continue;
    const nameKey = exactNameKey(contact.firstName, contact.lastName);
    if (!nameKey) continue;
    const peopleWithName = peopleByExactName.get(nameKey) ?? [];
    if (peopleWithName.length !== 1) continue;
    const possiblePerson = peopleWithName[0];
    const possibleEmails = emailsByPerson.get(possiblePerson.id) ?? [];
    if (possibleEmails.length === 0) continue;
    emailDifferences.push({
      personId: possiblePerson.id,
      personName: displayName(possiblePerson),
      flodeskEmail: contact.email,
      crmEmails: [...possibleEmails].sort((a, b) => a.localeCompare(b)),
      matchBasis: "exact_name",
    });
  }

  const byPersonAndEmail = (
    a: { personName: string; email?: string; flodeskEmail?: string },
    b: { personName: string; email?: string; flodeskEmail?: string },
  ) =>
    a.personName.localeCompare(b.personName) ||
    (a.email ?? a.flodeskEmail ?? "").localeCompare(
      b.email ?? b.flodeskEmail ?? "",
    );

  subscriptionDifferences.sort(byPersonAndEmail);
  emailDifferences.sort(byPersonAndEmail);
  return { subscriptionDifferences, emailDifferences };
}
