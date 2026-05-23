import OpportunityDetail from "./opportunity-detail";

export default function PledgeDetail() {
  return (
    <OpportunityDetail
      routePattern="/pledges/:id"
      backHref="/pledges"
      backLabel="← Back to pledges"
      entityLabel="Pledge"
    />
  );
}
