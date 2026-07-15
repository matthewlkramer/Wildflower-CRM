import React, { useState } from "react";
import { 
  Building2, 
  MapPin, 
  Globe, 
  Mail, 
  Phone, 
  ChevronDown, 
  ChevronUp, 
  Plus, 
  MessageCircle, 
  FileText, 
  CheckSquare, 
  Edit3, 
  Flag, 
  Archive,
  ExternalLink,
  Target,
  Users,
  DollarSign,
  Calendar,
  Clock,
  Briefcase,
  AlertTriangle,
  ArrowUpRight,
  Search,
  Activity
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

const Section = ({ title, children, defaultOpen = true, icon: Icon }: any) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="mb-6 bg-white border rounded-xl overflow-hidden shadow-sm">
      <CollapsibleTrigger className="flex items-center justify-between w-full p-5 hover:bg-slate-50 transition-colors">
        <div className="flex items-center gap-3">
          {Icon && <Icon className="w-5 h-5 text-slate-400" />}
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        </div>
        {isOpen ? <ChevronUp className="w-5 h-5 text-slate-400" /> : <ChevronDown className="w-5 h-5 text-slate-400" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="p-5 pt-0 border-t">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

export function ActionRail() {
  return (
    <div className="flex h-screen bg-slate-50 font-sans text-slate-900">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        .font-sans { font-family: 'Inter', sans-serif; }
      `}</style>
      
      {/* Main Flow Column */}
      <div className="flex-1 overflow-y-auto pb-20">
        <div className="max-w-4xl mx-auto px-8 py-10">
          
          {/* Header Area */}
          <div className="mb-8">
            <div className="flex items-center gap-3 mb-3">
              <Badge variant="secondary" className="bg-blue-100 text-blue-700 hover:bg-blue-100 font-medium">Foundation</Badge>
              <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50">
                <Search className="w-3 h-3 mr-1" /> Needs Research
              </Badge>
            </div>
            <h1 className="text-4xl font-bold tracking-tight text-slate-900 mb-2">Chan Zuckerberg Initiative</h1>
            <div className="flex items-center text-slate-500 gap-4 text-sm">
              <span className="flex items-center gap-1"><MapPin className="w-4 h-4" /> Redwood City, CA</span>
              <span className="flex items-center gap-1"><Globe className="w-4 h-4" /> chanzuckerberg.com</span>
            </div>
          </div>

          {/* Section 1: Relationship */}
          <Section title="People & Affiliations" icon={Users} defaultOpen={true}>
            <div className="space-y-4 mt-4">
              {[
                { name: "Priscilla Chan", role: "Co-Founder & Co-CEO", status: "Active" },
                { name: "Mark Zuckerberg", role: "Co-Founder & Co-CEO", status: "Active" },
                { name: "Sandra Taylor", role: "Program Officer, Education", status: "Active" }
              ].map((person, i) => (
                <div key={i} className="flex items-center justify-between p-3 rounded-lg hover:bg-slate-50 border border-transparent hover:border-slate-100 transition-colors">
                  <div className="flex items-center gap-4">
                    <Avatar>
                      <AvatarFallback className="bg-indigo-100 text-indigo-700">
                        {person.name.split(' ').map(n => n[0]).join('')}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="font-medium">{person.name}</div>
                      <div className="text-sm text-slate-500">{person.role}</div>
                    </div>
                  </div>
                  <Badge variant="secondary" className="bg-emerald-50 text-emerald-600 border-emerald-100">{person.status}</Badge>
                </div>
              ))}
            </div>
          </Section>

          {/* Section 2: Money / Pipeline */}
          <Section title="Funding & Pipeline" icon={DollarSign} defaultOpen={true}>
            <div className="grid grid-cols-2 gap-4 mt-4">
              <div className="border rounded-lg p-4">
                <div className="text-sm text-slate-500 mb-1">Active Opportunity</div>
                <div className="text-xl font-semibold mb-2">$250,000</div>
                <div className="text-sm font-medium text-blue-600 mb-1">Q3 Whole Child Initiative</div>
                <div className="text-xs text-slate-400">Stage: Proposal Submitted</div>
              </div>
              <div className="border rounded-lg p-4">
                <div className="text-sm text-slate-500 mb-1">Recent Gift</div>
                <div className="text-xl font-semibold mb-2">$100,000</div>
                <div className="text-sm font-medium text-slate-700 mb-1">General Operating Support</div>
                <div className="text-xs text-slate-400">Received: Oct 12, 2023</div>
              </div>
            </div>
          </Section>

          {/* Section 3: Organization Details */}
          <Section title="Details & Interests" icon={Target} defaultOpen={false}>
            <div className="grid grid-cols-2 gap-x-8 gap-y-6 mt-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 mb-3 border-b pb-2">Organizational Profile</h3>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between"><dt className="text-slate-500">Status</dt><dd className="font-medium">Active</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Employee Count</dt><dd className="font-medium">1,000+</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Total Assets</dt><dd className="font-medium">$1B+</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Makes Grants</dt><dd className="font-medium">Yes</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Strategic Alignment</dt><dd className="font-medium">High</dd></div>
                </dl>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-900 mb-3 border-b pb-2">Interests</h3>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between"><dt className="text-slate-500">Thematic</dt><dd className="font-medium text-right">Whole Child, Education</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Ages</dt><dd className="font-medium text-right">Pre-K, Elementary</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Regions</dt><dd className="font-medium text-right">Bay Area, National</dd></div>
                </dl>
              </div>
            </div>
          </Section>

          {/* Section 4: Contact & Links */}
          <Section title="Contact Information" icon={Briefcase} defaultOpen={false}>
            <div className="grid grid-cols-2 gap-8 mt-4">
              <div>
                <div className="flex items-start gap-3 mb-4">
                  <MapPin className="w-4 h-4 text-slate-400 mt-0.5" />
                  <div className="text-sm">
                    801 Jefferson Ave<br/>
                    Redwood City, CA 94063<br/>
                    United States
                  </div>
                </div>
                <div className="flex items-center gap-3 mb-4 text-sm">
                  <Phone className="w-4 h-4 text-slate-400" />
                  <span>(650) 555-0198</span>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <Mail className="w-4 h-4 text-slate-400" />
                  <a href="#" className="text-blue-600 hover:underline">info@chanzuckerberg.com</a>
                </div>
              </div>
              <div>
                <div className="flex items-center gap-3 mb-4 text-sm">
                  <Globe className="w-4 h-4 text-slate-400" />
                  <a href="#" className="text-blue-600 hover:underline">chanzuckerberg.com</a>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <ExternalLink className="w-4 h-4 text-slate-400" />
                  <a href="#" className="text-blue-600 hover:underline">LinkedIn Profile</a>
                </div>
              </div>
            </div>
          </Section>

          {/* Section 5: Activity Feed */}
          <Section title="Activity Feed" icon={Activity} defaultOpen={true}>
            <div className="relative pl-4 border-l-2 border-slate-100 space-y-8 mt-6 ml-2">
              <div className="relative">
                <div className="absolute -left-[25px] bg-blue-100 p-1 rounded-full">
                  <MessageCircle className="w-4 h-4 text-blue-600" />
                </div>
                <div className="text-sm">
                  <div className="font-medium mb-1">Met with Sandra Taylor <span className="text-slate-400 font-normal ml-2">Yesterday</span></div>
                  <div className="text-slate-600 bg-slate-50 p-3 rounded-lg border">
                    Discussed the Q3 proposal. They are very interested in our new Montessori expansion in Puerto Rico. Next steps are to send the updated budget.
                  </div>
                </div>
              </div>
              <div className="relative">
                <div className="absolute -left-[25px] bg-amber-100 p-1 rounded-full">
                  <Mail className="w-4 h-4 text-amber-600" />
                </div>
                <div className="text-sm">
                  <div className="font-medium mb-1">Email sent to General Inbox <span className="text-slate-400 font-normal ml-2">Oct 24</span></div>
                  <div className="text-slate-600">Checking in on the status of our submitted report.</div>
                </div>
              </div>
              <div className="relative">
                <div className="absolute -left-[25px] bg-emerald-100 p-1 rounded-full">
                  <CheckSquare className="w-4 h-4 text-emerald-600" />
                </div>
                <div className="text-sm">
                  <div className="font-medium mb-1">Task Completed: Submit Q3 Proposal <span className="text-slate-400 font-normal ml-2">Oct 15</span></div>
                </div>
              </div>
            </div>
          </Section>

        </div>
      </div>

      {/* Sticky Right Rail */}
      <div className="w-80 bg-white border-l shadow-[-4px_0_24px_rgba(0,0,0,0.02)] flex flex-col sticky top-0 h-screen overflow-y-auto">
        
        {/* Quick Facts / Highlights */}
        <div className="p-6 bg-slate-50/50 border-b">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4">Highlights</h3>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-500">Priority</span>
              <Badge className="bg-red-50 text-red-700 border-red-200">Tier 1</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-500">Capacity</span>
              <span className="text-sm font-medium">$5M+</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-500">Connection</span>
              <span className="text-sm font-medium text-emerald-600">Strong</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-500">Enthusiasm</span>
              <span className="text-sm font-medium">High</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-500">Owner</span>
              <div className="flex items-center gap-2">
                <Avatar className="w-5 h-5"><AvatarFallback className="text-[10px]">JD</AvatarFallback></Avatar>
                <span className="text-sm font-medium">Jane Doe</span>
              </div>
            </div>
            <Separator className="my-2" />
            <div>
              <span className="text-xs text-slate-500 block mb-1">Lifetime Giving</span>
              <span className="text-2xl font-bold text-slate-900">$850,000</span>
            </div>
          </div>
        </div>

        {/* Actions Menu */}
        <div className="p-4 flex-1 space-y-6">
          
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 px-2">Relationship Actions</h3>
            <div className="space-y-1">
              <Button variant="ghost" className="w-full justify-start font-normal text-slate-600 hover:text-slate-900 hover:bg-slate-100">
                <Users className="w-4 h-4 mr-3 text-slate-400" /> Add Person Role
              </Button>
              <Button variant="ghost" className="w-full justify-start font-normal text-slate-600 hover:text-slate-900 hover:bg-slate-100">
                <MessageCircle className="w-4 h-4 mr-3 text-slate-400" /> Log Interaction
              </Button>
              <Button variant="ghost" className="w-full justify-start font-normal text-slate-600 hover:text-slate-900 hover:bg-slate-100">
                <FileText className="w-4 h-4 mr-3 text-slate-400" /> Add Note
              </Button>
              <Button variant="ghost" className="w-full justify-start font-normal text-slate-600 hover:text-slate-900 hover:bg-slate-100">
                <CheckSquare className="w-4 h-4 mr-3 text-slate-400" /> Add Task
              </Button>
            </div>
          </div>

          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 px-2">Money Actions</h3>
            <div className="space-y-1">
              <Button variant="ghost" className="w-full justify-start font-normal text-slate-600 hover:text-slate-900 hover:bg-slate-100">
                <Target className="w-4 h-4 mr-3 text-slate-400" /> New Opportunity
              </Button>
              <Button variant="ghost" className="w-full justify-start font-normal text-slate-600 hover:text-slate-900 hover:bg-slate-100">
                <DollarSign className="w-4 h-4 mr-3 text-slate-400" /> Log Gift
              </Button>
            </div>
          </div>

          <Separator />

          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 px-2">Record Actions</h3>
            <div className="space-y-1">
              <Button variant="ghost" className="w-full justify-start font-normal text-slate-600 hover:text-slate-900 hover:bg-slate-100">
                <Edit3 className="w-4 h-4 mr-3 text-slate-400" /> Edit Fields
              </Button>
              <Button variant="ghost" className="w-full justify-start font-normal text-amber-600 hover:text-amber-700 hover:bg-amber-50">
                <Flag className="w-4 h-4 mr-3" /> Flag for Research
              </Button>
              <Button variant="ghost" className="w-full justify-start font-normal text-red-600 hover:text-red-700 hover:bg-red-50">
                <Archive className="w-4 h-4 mr-3" /> Archive Record
              </Button>
            </div>
          </div>

        </div>
      </div>

    </div>
  );
}
