import React from "react";
import "./_dossier-zones.css";
import {
  Building2,
  MapPin,
  Globe,
  Mail,
  Phone,
  Edit2,
  Flag,
  Archive,
  Plus,
  ArrowUpRight,
  MessageSquare,
  FileText,
  CheckCircle2,
  Circle,
  Briefcase,
  DollarSign,
  Calendar,
  AlertCircle
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

export function DossierZones() {
  return (
    <div className="dossier-zones pb-24">
      {/* Header Area */}
      <div className="bg-white border-b border-[hsl(var(--dz-border))] px-8 py-6 sticky top-0 z-20">
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-[hsl(var(--dz-accent-light))] flex items-center justify-center text-[hsl(var(--dz-accent))]">
              <Building2 className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="dossier-header-title text-2xl font-bold text-gray-900">
                  Chan Zuckerberg Initiative
                </h1>
                <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
                  Family Foundation
                </Badge>
                <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                  <AlertCircle className="w-3 h-3 mr-1" /> Needs Research
                </Badge>
              </div>
              <p className="text-sm text-gray-500 mt-1">Palo Alto, CA • Last updated 2 days ago</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8">
              <Edit2 className="w-4 h-4 mr-2" /> Edit Info
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-amber-700 border-amber-200 hover:bg-amber-50">
              <Flag className="w-4 h-4 mr-2" /> Flag for Research
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-red-600 border-red-200 hover:bg-red-50">
              <Archive className="w-4 h-4 mr-2" /> Archive
            </Button>
          </div>
        </div>

        {/* Highlights Bar */}
        <div className="flex flex-wrap gap-x-8 gap-y-4 text-sm bg-gray-50/50 p-4 rounded-lg border border-gray-100">
          <div>
            <span className="text-gray-500 block text-xs uppercase tracking-wider font-semibold mb-1">Priority</span>
            <span className="font-medium text-gray-900 flex items-center gap-1">Tier 1</span>
          </div>
          <div>
            <span className="text-gray-500 block text-xs uppercase tracking-wider font-semibold mb-1">Capacity</span>
            <span className="font-medium text-gray-900">$5M+</span>
          </div>
          <div>
            <span className="text-gray-500 block text-xs uppercase tracking-wider font-semibold mb-1">Connection</span>
            <span className="font-medium text-gray-900">Strong (Board Member)</span>
          </div>
          <div>
            <span className="text-gray-500 block text-xs uppercase tracking-wider font-semibold mb-1">Enthusiasm</span>
            <span className="font-medium text-gray-900 flex items-center gap-1 text-green-600">
              High
            </span>
          </div>
          <div>
            <span className="text-gray-500 block text-xs uppercase tracking-wider font-semibold mb-1">Owner</span>
            <span className="font-medium text-gray-900 flex items-center gap-2">
              <div className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-[10px] font-bold">EK</div>
              Elena Kagan
            </span>
          </div>
          <div>
            <span className="text-gray-500 block text-xs uppercase tracking-wider font-semibold mb-1">Lifetime Giving</span>
            <span className="font-medium text-gray-900">$1,250,000</span>
          </div>
        </div>
      </div>

      {/* Dossier Band (Dense DLs) */}
      <div className="bg-white border-b border-[hsl(var(--dz-border))] px-8 py-8 shadow-sm">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          
          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2 border-b pb-2">
              <FileText className="w-4 h-4 text-gray-400" /> Details
            </h3>
            <dl className="dossier-dl">
              <dt className="dossier-dt">Status</dt>
              <dd className="dossier-dd"><Badge variant="secondary" className="font-normal text-xs bg-green-100 text-green-800">Active</Badge></dd>
              
              <dt className="dossier-dt">Employees</dt>
              <dd className="dossier-dd">450</dd>
              
              <dt className="dossier-dt">Assets</dt>
              <dd className="dossier-dd">$45B</dd>
              
              <dt className="dossier-dt">Grants/PRIs</dt>
              <dd className="dossier-dd">Yes</dd>

              <dt className="dossier-dt">Alignment</dt>
              <dd className="dossier-dd">Strong</dd>

              <dt className="dossier-dt">Tags</dt>
              <dd className="dossier-dd">
                <span className="inline-flex gap-1 flex-wrap">
                  <span className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs">Education</span>
                  <span className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs">Tech</span>
                </span>
              </dd>

              <dt className="dossier-dt">Notes</dt>
              <dd className="dossier-dd text-gray-600 italic">"Focusing heavily on personalized learning tools this year."</dd>
            </dl>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2 border-b pb-2">
              <Globe className="w-4 h-4 text-gray-400" /> Interests
            </h3>
            <dl className="dossier-dl">
              <dt className="dossier-dt">Thematic</dt>
              <dd className="dossier-dd">Whole-child education, Science</dd>
              
              <dt className="dossier-dt">Ages</dt>
              <dd className="dossier-dd">K-12</dd>
              
              <dt className="dossier-dt">Gov Models</dt>
              <dd className="dossier-dd">Public, Charter</dd>
              
              <dt className="dossier-dt">Regions</dt>
              <dd className="dossier-dd">Bay Area, Massachusetts, Puerto Rico</dd>

              <dt className="dossier-dt">Priority Notes</dt>
              <dd className="dossier-dd text-gray-600 italic">Looking to expand their footprint in early childhood literacy interventions.</dd>
            </dl>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2 border-b pb-2">
              <MapPin className="w-4 h-4 text-gray-400" /> Contact Info
            </h3>
            <dl className="dossier-dl">
              <dt className="dossier-dt">HQ</dt>
              <dd className="dossier-dd">
                801 Jefferson Ave<br/>
                Redwood City, CA 94063
              </dd>
              
              <dt className="dossier-dt">Mailing</dt>
              <dd className="dossier-dd text-gray-500">Same as HQ</dd>
              
              <dt className="dossier-dt">General Phone</dt>
              <dd className="dossier-dd">(650) 555-0199</dd>
              
              <dt className="dossier-dt">General Email</dt>
              <dd className="dossier-dd text-blue-600">info@chanzuckerberg.com</dd>
            </dl>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2 border-b pb-2">
              <ArrowUpRight className="w-4 h-4 text-gray-400" /> Links
            </h3>
            <div className="flex flex-col gap-2 text-sm">
              <a href="#" className="text-blue-600 hover:underline flex items-center gap-2">
                chanzuckerberg.com <ArrowUpRight className="w-3 h-3" />
              </a>
              <a href="#" className="text-blue-600 hover:underline flex items-center gap-2">
                LinkedIn Profile <ArrowUpRight className="w-3 h-3" />
              </a>
              <a href="#" className="text-blue-600 hover:underline flex items-center gap-2">
                Guidestar / 990s <ArrowUpRight className="w-3 h-3" />
              </a>
            </div>
          </div>

        </div>
      </div>

      <div className="px-8 mt-8 space-y-8">
        
        {/* PEOPLE ZONE */}
        <section className="bg-white rounded-xl shadow-sm border border-[hsl(var(--dz-border))] overflow-hidden">
          <header className="dossier-zone-header px-6 py-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Briefcase className="w-5 h-5 text-[hsl(var(--dz-accent))]" />
              People & Affiliations
            </h2>
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-600 flex items-center gap-2 cursor-pointer">
                <input type="checkbox" className="rounded border-gray-300 text-blue-600" defaultChecked />
                Hide Inactive
              </label>
              <Separator orientation="vertical" className="h-6" />
              <Button size="sm" className="h-8">
                <Plus className="w-4 h-4 mr-1" /> Add Role
              </Button>
            </div>
          </header>
          <div className="p-0">
            <table className="w-full text-sm text-left">
              <thead className="bg-gray-50 text-gray-500 uppercase tracking-wider text-xs font-semibold">
                <tr>
                  <th className="px-6 py-3 border-b">Person</th>
                  <th className="px-6 py-3 border-b">Role / Title</th>
                  <th className="px-6 py-3 border-b">Status</th>
                  <th className="px-6 py-3 border-b text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                <tr className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4 font-medium text-gray-900">Dr. Priscilla Chan</td>
                  <td className="px-6 py-4 text-gray-600">Co-Founder & Co-CEO</td>
                  <td className="px-6 py-4"><Badge variant="secondary" className="bg-green-100 text-green-800 font-normal">Active</Badge></td>
                  <td className="px-6 py-4 text-right">
                    <Button variant="ghost" size="sm" className="h-8 text-blue-600">Edit</Button>
                  </td>
                </tr>
                <tr className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4 font-medium text-gray-900">Sandra Liu Huang</td>
                  <td className="px-6 py-4 text-gray-600">Head of Education</td>
                  <td className="px-6 py-4"><Badge variant="secondary" className="bg-green-100 text-green-800 font-normal">Active</Badge></td>
                  <td className="px-6 py-4 text-right">
                    <Button variant="ghost" size="sm" className="h-8 text-blue-600">Edit</Button>
                  </td>
                </tr>
                <tr className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4 font-medium text-gray-900">Jim Shelton</td>
                  <td className="px-6 py-4 text-gray-600">Former Head of Education</td>
                  <td className="px-6 py-4"><Badge variant="secondary" className="bg-gray-100 text-gray-600 font-normal">Inactive</Badge></td>
                  <td className="px-6 py-4 text-right">
                    <Button variant="ghost" size="sm" className="h-8 text-blue-600">Edit</Button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* MONEY ZONE (Opportunities + Gifts) */}
        <section className="bg-white rounded-xl shadow-sm border border-[hsl(var(--dz-border))] overflow-hidden">
          <header className="dossier-zone-header px-6 py-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-emerald-600" />
              Opportunities & Gifts
            </h2>
            <div className="flex items-center gap-3">
              <Button size="sm" variant="outline" className="h-8">
                <Plus className="w-4 h-4 mr-1" /> Add Opportunity
              </Button>
              <Button size="sm" variant="outline" className="h-8 border-emerald-200 text-emerald-700 hover:bg-emerald-50">
                <Plus className="w-4 h-4 mr-1" /> Log Gift
              </Button>
            </div>
          </header>
          <div className="p-0">
            {/* Timeline-style strip */}
            <div className="divide-y divide-gray-100">
              <div className="px-6 py-4 flex items-center gap-6 hover:bg-gray-50 transition-colors">
                <div className="w-32 flex-shrink-0 text-sm text-gray-500 font-medium">Nov 2023</div>
                <div className="w-10 flex-shrink-0 flex justify-center">
                  <div className="w-8 h-8 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-100">
                    <AlertCircle className="w-4 h-4" />
                  </div>
                </div>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-gray-900">FY24 Education Portfolio Grant</div>
                  <div className="text-sm text-gray-500">Opportunity • Stage: Proposal Submitted</div>
                </div>
                <div className="text-right">
                  <div className="text-base font-bold text-gray-900">$500,000</div>
                  <div className="text-xs text-gray-500">Requested</div>
                </div>
              </div>

              <div className="px-6 py-4 flex items-center gap-6 bg-emerald-50/30 hover:bg-emerald-50 transition-colors">
                <div className="w-32 flex-shrink-0 text-sm text-gray-500 font-medium">Dec 2022</div>
                <div className="w-10 flex-shrink-0 flex justify-center">
                  <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center border border-emerald-200">
                    <DollarSign className="w-4 h-4" />
                  </div>
                </div>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-gray-900">FY23 Core Support</div>
                  <div className="text-sm text-gray-500">Gift • Received</div>
                </div>
                <div className="text-right">
                  <div className="text-base font-bold text-emerald-700">$250,000</div>
                  <div className="text-xs text-gray-500">Received via Wire</div>
                </div>
              </div>

              <div className="px-6 py-4 flex items-center gap-6 bg-emerald-50/30 hover:bg-emerald-50 transition-colors">
                <div className="w-32 flex-shrink-0 text-sm text-gray-500 font-medium">Oct 2021</div>
                <div className="w-10 flex-shrink-0 flex justify-center">
                  <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center border border-emerald-200">
                    <DollarSign className="w-4 h-4" />
                  </div>
                </div>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-gray-900">FY22 Literacy Initiative</div>
                  <div className="text-sm text-gray-500">Gift • Received</div>
                </div>
                <div className="text-right">
                  <div className="text-base font-bold text-emerald-700">$1,000,000</div>
                  <div className="text-xs text-gray-500">Received via DAF</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ACTIVITY & TASKS ZONE */}
        <section className="bg-white rounded-xl shadow-sm border border-[hsl(var(--dz-border))] overflow-hidden">
          <header className="dossier-zone-header px-6 py-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Calendar className="w-5 h-5 text-indigo-600" />
              Activity & Tasks
            </h2>
            <div className="flex items-center gap-3">
              <Button size="sm" variant="outline" className="h-8">
                <CheckCircle2 className="w-4 h-4 mr-1" /> Add Task
              </Button>
              <Button size="sm" variant="outline" className="h-8">
                <FileText className="w-4 h-4 mr-1" /> Add Note
              </Button>
              <Button size="sm" className="h-8 bg-indigo-600 hover:bg-indigo-700 text-white">
                <MessageSquare className="w-4 h-4 mr-1" /> Log Interaction
              </Button>
            </div>
          </header>
          
          <div className="grid grid-cols-1 lg:grid-cols-3 divide-y lg:divide-y-0 lg:divide-x divide-gray-100">
            {/* Tasks Panel */}
            <div className="p-6 bg-gray-50/50">
              <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-4">Open Tasks</h3>
              <div className="space-y-3">
                <div className="flex items-start gap-3 p-3 bg-white rounded-lg border border-gray-200 shadow-sm">
                  <button className="mt-0.5 text-gray-400 hover:text-green-600 transition-colors">
                    <Circle className="w-5 h-5" />
                  </button>
                  <div>
                    <div className="text-sm font-medium text-gray-900">Draft FY24 Proposal</div>
                    <div className="text-xs text-red-600 font-medium mt-1">Due Today</div>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 bg-white rounded-lg border border-gray-200 shadow-sm">
                  <button className="mt-0.5 text-gray-400 hover:text-green-600 transition-colors">
                    <Circle className="w-5 h-5" />
                  </button>
                  <div>
                    <div className="text-sm font-medium text-gray-900">Schedule check-in with Sandra</div>
                    <div className="text-xs text-gray-500 mt-1">Due next week</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Activity Feed */}
            <div className="p-6 lg:col-span-2">
              <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-4">Timeline</h3>
              
              <div className="space-y-6 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-slate-200 before:to-transparent">
                
                {/* Interaction Item */}
                <div className="relative flex items-start md:justify-between gap-4">
                  <div className="md:w-1/2 flex justify-end md:pr-8 text-right hidden md:block">
                    <div className="text-sm text-gray-500">Yesterday, 2:30 PM</div>
                    <div className="text-xs text-gray-400">by Elena Kagan</div>
                  </div>
                  <div className="absolute left-0 md:left-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-white border-2 border-indigo-200 -translate-x-1/2 z-10">
                    <MessageSquare className="h-4 w-4 text-indigo-600" />
                  </div>
                  <div className="pl-12 md:pl-8 md:w-1/2">
                    <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                      <div className="font-semibold text-sm text-gray-900">Call with Sandra</div>
                      <div className="text-sm text-gray-600 mt-1">
                        Discussed the upcoming FY24 proposal. They are very interested in seeing our data on early literacy outcomes in the Northeast region.
                      </div>
                    </div>
                  </div>
                </div>

                {/* Email Item */}
                <div className="relative flex items-start md:justify-between gap-4">
                  <div className="md:w-1/2 flex justify-end md:pr-8 text-right hidden md:block">
                    <div className="text-sm text-gray-500">Last Week</div>
                    <div className="text-xs text-gray-400">System Log</div>
                  </div>
                  <div className="absolute left-0 md:left-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-white border-2 border-blue-200 -translate-x-1/2 z-10">
                    <Mail className="h-4 w-4 text-blue-600" />
                  </div>
                  <div className="pl-12 md:pl-8 md:w-1/2">
                    <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                      <div className="font-semibold text-sm text-gray-900">Email Received: "Re: Quarterly Update"</div>
                      <div className="text-sm text-gray-600 mt-1 truncate">
                        "Thanks for the update, Elena. Things are looking solid..."
                      </div>
                    </div>
                  </div>
                </div>

                {/* Note Item */}
                <div className="relative flex items-start md:justify-between gap-4">
                  <div className="md:w-1/2 flex justify-end md:pr-8 text-right hidden md:block">
                    <div className="text-sm text-gray-500">Last Month</div>
                    <div className="text-xs text-gray-400">by Elena Kagan</div>
                  </div>
                  <div className="absolute left-0 md:left-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-white border-2 border-amber-200 -translate-x-1/2 z-10">
                    <FileText className="h-4 w-4 text-amber-600" />
                  </div>
                  <div className="pl-12 md:pl-8 md:w-1/2">
                    <div className="bg-amber-50 p-4 rounded-lg border border-amber-100 shadow-sm">
                      <div className="font-semibold text-sm text-amber-900">Research Note</div>
                      <div className="text-sm text-amber-800 mt-1">
                        CZI just announced a new $10M fund for tech-enabled teaching tools. We should position our new software initiative for this.
                      </div>
                    </div>
                  </div>
                </div>

              </div>
            </div>
          </div>
        </section>

      </div>
    </div>
  );
}
