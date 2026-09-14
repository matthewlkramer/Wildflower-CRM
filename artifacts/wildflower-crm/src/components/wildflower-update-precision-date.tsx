import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WildflowerUpdateDatePrecision, WildflowerUpdateEventDate } from "@workspace/api-client-react";

export function WildflowerUpdatePrecisionDateInput({
  value,
  onChange,
  disabled
}: {
  value: WildflowerUpdateEventDate;
  onChange: (val: WildflowerUpdateEventDate) => void;
  disabled?: boolean;
}) {
  const p = value.precision;

  return (
    <div className="flex flex-col gap-2">
      <Select
        disabled={disabled}
        value={p as string}
        onValueChange={(v) => onChange({ precision: v as any })}
      >
        <SelectTrigger>
          <SelectValue placeholder="Precision" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="exact">Exact Date</SelectItem>
          <SelectItem value="month">Month & Year</SelectItem>
          <SelectItem value="month_range">Month Range</SelectItem>
          <SelectItem value="season">Season & Year</SelectItem>
          <SelectItem value="year">Year Only</SelectItem>
          <SelectItem value="date_range">Date Range</SelectItem>
          <SelectItem value="unknown">Unknown</SelectItem>
        </SelectContent>
      </Select>

      {p === "exact" && (
        <Input 
          type="date"
          disabled={disabled}
          value={value.startDate ?? ""}
          onChange={(e) => onChange({ ...value, startDate: e.target.value || null })}
        />
      )}

      {p === "date_range" && (
        <div className="flex gap-2 items-center">
          <Input 
            type="date"
            disabled={disabled}
            value={value.startDate ?? ""}
            onChange={(e) => onChange({ ...value, startDate: e.target.value || null })}
          />
          <span className="text-muted-foreground text-sm">to</span>
          <Input 
            type="date"
            disabled={disabled}
            value={value.endDate ?? ""}
            onChange={(e) => onChange({ ...value, endDate: e.target.value || null })}
          />
        </div>
      )}

      {p === "month_range" && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2 items-center">
            <Select
              disabled={disabled}
              value={(value as any).startMonth ? (value as any).startMonth.toString() : ""}
              onValueChange={(v) => onChange({ ...value, startMonth: parseInt(v, 10) } as any)}
            >
              <SelectTrigger><SelectValue placeholder="Start month" /></SelectTrigger>
              <SelectContent>
                {Array.from({length: 12}).map((_, i) => (
                  <SelectItem key={i+1} value={(i+1).toString()}>{new Date(2000, i).toLocaleString('default', { month: 'short' })}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input 
              type="number"
              placeholder="Start year"
              disabled={disabled}
              value={(value as any).startYear ?? ""}
              onChange={(e) => onChange({ ...value, startYear: e.target.value ? parseInt(e.target.value, 10) : null } as any)}
            />
          </div>
          <div className="text-muted-foreground text-sm text-center">to</div>
          <div className="flex gap-2 items-center">
            <Select
              disabled={disabled}
              value={(value as any).endMonth ? (value as any).endMonth.toString() : ""}
              onValueChange={(v) => onChange({ ...value, endMonth: parseInt(v, 10) } as any)}
            >
              <SelectTrigger><SelectValue placeholder="End month" /></SelectTrigger>
              <SelectContent>
                {Array.from({length: 12}).map((_, i) => (
                  <SelectItem key={i+1} value={(i+1).toString()}>{new Date(2000, i).toLocaleString('default', { month: 'short' })}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input 
              type="number"
              placeholder="End year"
              disabled={disabled}
              value={(value as any).endYear ?? ""}
              onChange={(e) => onChange({ ...value, endYear: e.target.value ? parseInt(e.target.value, 10) : null } as any)}
            />
          </div>
        </div>
      )}

      {(p === "month" || p === "season" || p === "year") && (
        <Input 
          type="number"
          placeholder="Year (e.g. 2024)"
          disabled={disabled}
          value={value.year ?? ""}
          onChange={(e) => onChange({ ...value, year: e.target.value ? parseInt(e.target.value, 10) : null })}
        />
      )}

      {p === "month" && (
        <Select
          disabled={disabled}
          value={value.month ? value.month.toString() : ""}
          onValueChange={(v) => onChange({ ...value, month: parseInt(v, 10) })}
        >
          <SelectTrigger><SelectValue placeholder="Select month..." /></SelectTrigger>
          <SelectContent>
            {Array.from({length: 12}).map((_, i) => (
              <SelectItem key={i+1} value={(i+1).toString()}>{new Date(2000, i).toLocaleString('default', { month: 'long' })}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {p === "season" && (
        <Select
          disabled={disabled}
          value={value.season ?? ""}
          onValueChange={(v) => onChange({ ...value, season: v })}
        >
          <SelectTrigger><SelectValue placeholder="Select season..." /></SelectTrigger>
          <SelectContent>
            <SelectItem value="Spring">Spring</SelectItem>
            <SelectItem value="Summer">Summer</SelectItem>
            <SelectItem value="Fall">Fall</SelectItem>
            <SelectItem value="Winter">Winter</SelectItem>
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
