import { describe, expect, it } from "vitest";
import { shouldSuppressInboundTrackingMessage } from "../lib/emailTrackingSuppression";

const directMessage = {
  fromEmail: "person@example.org",
  subject: "Following up on our conversation",
  snippet: "Would Tuesday afternoon work for you?",
  bodyText: "Would Tuesday afternoon work for you?",
  bodyHtml: null,
  aiSummary: null,
};

describe("shouldSuppressInboundTrackingMessage", () => {
  it("keeps direct human correspondence", () => {
    expect(shouldSuppressInboundTrackingMessage(directMessage)).toBe(false);
  });

  it.each([
    "Automatic reply: Following up on our conversation",
    "Auto response: Following up on our conversation",
    "Out of office: back next week",
    "OOO: back next week",
    "Vacation reply",
  ])("suppresses automatic-reply subject %s", (subject) => {
    expect(
      shouldSuppressInboundTrackingMessage({ ...directMessage, subject }),
    ).toBe(true);
  });

  it("suppresses an out-of-office response detected in the body", () => {
    expect(
      shouldSuppressInboundTrackingMessage({
        ...directMessage,
        subject: "Re: Site visit",
        bodyText: "I'm currently out of the office and will return on Monday.",
      }),
    ).toBe(true);
  });

  it.each([
    "noreply@example.org",
    "notifications@example.org",
    "digest-updates@example.org",
  ])("suppresses machine sender %s", (fromEmail) => {
    expect(
      shouldSuppressInboundTrackingMessage({ ...directMessage, fromEmail }),
    ).toBe(true);
  });

  it("suppresses a mailing-list footer from an otherwise ordinary CRM address", () => {
    expect(
      shouldSuppressInboundTrackingMessage({
        ...directMessage,
        subject: "September education update",
        bodyText:
          "News from the field. View this email in your browser. Manage your email preferences or unsubscribe.",
      }),
    ).toBe(true);
  });

  it("suppresses unmistakable computer-generated content", () => {
    expect(
      shouldSuppressInboundTrackingMessage({
        ...directMessage,
        subject: "Re: Grant portal",
        bodyText:
          "This is an automatically generated message. Please do not reply to this email.",
      }),
    ).toBe(true);
  });

  it.each([
    "Your payment confirmation",
    "Weekly digest: September opportunities",
    "Delivery status notification",
  ])("suppresses machine-generated subject %s", (subject) => {
    expect(
      shouldSuppressInboundTrackingMessage({ ...directMessage, subject }),
    ).toBe(true);
  });

  it("does not suppress a human request containing the word unsubscribe alone", () => {
    expect(
      shouldSuppressInboundTrackingMessage({
        ...directMessage,
        bodyText:
          "Could you unsubscribe my former colleague and contact me instead?",
      }),
    ).toBe(false);
  });

  it("does not suppress a direct reply because quoted history was automated", () => {
    expect(
      shouldSuppressInboundTrackingMessage({
        ...directMessage,
        subject: "Re: Site visit",
        bodyText:
          "Tuesday works for me.\n\nOn Monday, Alex wrote:\n> I'm currently out of the office.\n> Manage preferences or unsubscribe.",
      }),
    ).toBe(false);
  });
});
