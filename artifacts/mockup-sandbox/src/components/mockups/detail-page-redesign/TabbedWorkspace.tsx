import React from "react"
import { Building, MapPin, Globe, Phone, Mail, Building2, Flag, MoreHorizontal, Pencil, Plus, MessageSquare, CheckSquare, Target, Info, Sparkles, HeartHandshake, Link as LinkIcon, History, ArrowUpRight, DollarSign } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Separator } from "@/components/ui/separator"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ScrollArea } from "@/components/ui/scroll-area"

export function TabbedWorkspace() {
  return (
    <div className="flex flex-col min-h-[100dvh] bg-slate-50 font-sans text-slate-900">
      <style dangerouslySetInnerHTML={{
        __html: `
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
          .font-sans { font-family: 'Inter', sans-serif; }
        `
      }} />

      {/* Global Header & Toolbar */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-6">
          <div className="flex items-start justify-between gap-6 mb-6">
            <div className="flex items-start gap-4">
              <div className="w-16 h-16 rounded-xl bg-indigo-100 flex items-center justify-center text-indigo-700 text-2xl font-bold shadow-sm border border-indigo-200/50">
                CZ
              </div>
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Chan Zuckerberg Initiative</h1>
                  <Badge variant="secondary" className="bg-blue-50 text-blue-700 hover:bg-blue-50 border-blue-200">Family Foundation</Badge>
                  <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50">
                    <Flag className="w-3 h-3 mr-1" />
                    Needs Research
                  </Badge>
                </div>
                <div className="flex items-center gap-4 text-sm text-slate-500">
                  <span className="flex items-center gap-1"><MapPin className="w-4 h-4" /> Redwood City, CA</span>
                  <span className="flex items-center gap-1"><Globe className="w-4 h-4" /> chanzuckerberg.com</span>
                  <span className="flex items-center gap-1"><Building2 className="w-4 h-4" /> 500+ employees</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="bg-white">
                <Pencil className="w-4 h-4 mr-2" />
                Edit Profile
              </Button>
              <Button variant="outline" size="sm" className="bg-white">
                <Flag className="w-4 h-4 mr-2" />
                Flag for Research
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" className="bg-white">
                    <MoreHorizontal className="w-4 h-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem>Archive Record</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Highlights Bar */}
          <div className="grid grid-cols-6 gap-4 py-4 px-5 bg-slate-50/50 rounded-xl border border-slate-100">
            <div>
              <div className="text-xs font-medium text-slate-500 mb-1">Priority</div>
              <div className="font-semibold text-slate-900 flex items-center gap-1">
                <Target className="w-4 h-4 text-indigo-600" /> High
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-slate-500 mb-1">Capacity Rating</div>
              <div className="font-semibold text-slate-900 flex items-center gap-1">
                <DollarSign className="w-4 h-4 text-green-600" /> $5M+
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-slate-500 mb-1">Connection</div>
              <div className="font-semibold text-slate-900 flex items-center gap-1">
                <HeartHandshake className="w-4 h-4 text-blue-600" /> Warm
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-slate-500 mb-1">Enthusiasm</div>
              <div className="font-semibold text-slate-900 flex items-center gap-1">
                <Sparkles className="w-4 h-4 text-amber-500" /> Very High
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-slate-500 mb-1">Owner</div>
              <div className="font-semibold text-slate-900 flex items-center gap-2">
                <Avatar className="w-5 h-5">
                  <AvatarFallback className="text-[10px] bg-indigo-100 text-indigo-700">SJ</AvatarFallback>
                </Avatar>
                Sarah Jenkins
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-slate-500 mb-1">Lifetime Giving</div>
              <div className="font-semibold text-slate-900">$1,250,000</div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Workspace */}
      <main className="max-w-7xl mx-auto px-6 py-8 w-full flex-1">
        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="w-full justify-start h-12 bg-transparent border-b border-slate-200 rounded-none p-0 space-x-8 mb-8">
            <TabsTrigger 
              value="overview" 
              className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-indigo-600 rounded-none px-0 h-12 text-sm font-medium text-slate-500 data-[state=active]:text-indigo-600"
            >
              Overview
            </TabsTrigger>
            <TabsTrigger 
              value="giving" 
              className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-indigo-600 rounded-none px-0 h-12 text-sm font-medium text-slate-500 data-[state=active]:text-indigo-600"
            >
              Giving & Opportunities
            </TabsTrigger>
            <TabsTrigger 
              value="people" 
              className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-indigo-600 rounded-none px-0 h-12 text-sm font-medium text-slate-500 data-[state=active]:text-indigo-600"
            >
              People
            </TabsTrigger>
            <TabsTrigger 
              value="activity" 
              className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-indigo-600 rounded-none px-0 h-12 text-sm font-medium text-slate-500 data-[state=active]:text-indigo-600"
            >
              Activity Feed
            </TabsTrigger>
          </TabsList>

          {/* OVERVIEW TAB */}
          <TabsContent value="overview" className="focus-visible:outline-none">
            <div className="grid grid-cols-12 gap-8">
              {/* Left Column */}
              <div className="col-span-8 space-y-8">
                <Card className="border-slate-200 shadow-sm">
                  <CardHeader className="flex flex-row items-center justify-between pb-4">
                    <CardTitle className="text-lg font-semibold text-slate-900">Organization Details</CardTitle>
                    <Button variant="ghost" size="sm" className="text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 -mr-2">Edit Details</Button>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 gap-x-12 gap-y-6">
                      <div>
                        <div className="text-sm text-slate-500 mb-1">Status</div>
                        <div className="text-sm font-medium text-slate-900 flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-green-500"></span> Active
                        </div>
                      </div>
                      <div>
                        <div className="text-sm text-slate-500 mb-1">Total Assets</div>
                        <div className="text-sm font-medium text-slate-900">$45.3B</div>
                      </div>
                      <div>
                        <div className="text-sm text-slate-500 mb-1">Grantmaking</div>
                        <div className="text-sm font-medium text-slate-900">Makes Grants & PRIs</div>
                      </div>
                      <div>
                        <div className="text-sm text-slate-500 mb-1">Strategic Alignment</div>
                        <div className="text-sm font-medium text-slate-900 flex items-center gap-2">
                          <div className="w-full bg-slate-100 rounded-full h-2 max-w-[100px]">
                            <div className="bg-indigo-600 h-2 rounded-full w-[85%]"></div>
                          </div>
                          <span>High (85%)</span>
                        </div>
                      </div>
                      <div className="col-span-2">
                        <div className="text-sm text-slate-500 mb-2">Tags</div>
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="secondary" className="bg-slate-100 text-slate-700 hover:bg-slate-100 font-normal">Education</Badge>
                          <Badge variant="secondary" className="bg-slate-100 text-slate-700 hover:bg-slate-100 font-normal">Technology</Badge>
                          <Badge variant="secondary" className="bg-slate-100 text-slate-700 hover:bg-slate-100 font-normal">Bay Area</Badge>
                          <Badge variant="secondary" className="bg-slate-100 text-slate-700 hover:bg-slate-100 font-normal">Montessori</Badge>
                        </div>
                      </div>
                      <div className="col-span-2">
                        <div className="text-sm text-slate-500 mb-2">General Notes</div>
                        <div className="text-sm text-slate-700 leading-relaxed bg-slate-50 p-4 rounded-lg border border-slate-100">
                          CZI is deeply interested in whole-child approaches to education. They have previously funded personalized learning initiatives and are increasingly looking at models that integrate academic achievement with social-emotional development.
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-slate-200 shadow-sm">
                  <CardHeader className="flex flex-row items-center justify-between pb-4">
                    <CardTitle className="text-lg font-semibold text-slate-900">Funding Interests</CardTitle>
                    <Button variant="ghost" size="sm" className="text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 -mr-2">Edit Interests</Button>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 gap-x-12 gap-y-6">
                      <div>
                        <div className="text-sm text-slate-500 mb-1">Thematic</div>
                        <div className="text-sm font-medium text-slate-900">Whole-Child, EdTech, Teacher Prep</div>
                      </div>
                      <div>
                        <div className="text-sm text-slate-500 mb-1">Ages</div>
                        <div className="text-sm font-medium text-slate-900">Pre-K, Elementary, Middle</div>
                      </div>
                      <div>
                        <div className="text-sm text-slate-500 mb-1">Gov Models</div>
                        <div className="text-sm font-medium text-slate-900">Charter, District, Micro-schools</div>
                      </div>
                      <div>
                        <div className="text-sm text-slate-500 mb-1">Regions</div>
                        <div className="text-sm font-medium text-slate-900">Bay Area, Massachusetts, National</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Right Column */}
              <div className="col-span-4 space-y-8">
                {/* Action Shortcuts */}
                <div className="bg-indigo-50/50 border border-indigo-100 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-indigo-900 mb-4">Quick Actions</h3>
                  <div className="flex flex-col gap-2">
                    <Button className="w-full justify-start bg-white hover:bg-indigo-50 text-indigo-700 border border-indigo-200 shadow-sm">
                      <MessageSquare className="w-4 h-4 mr-2" /> Log Interaction
                    </Button>
                    <Button className="w-full justify-start bg-white hover:bg-indigo-50 text-indigo-700 border border-indigo-200 shadow-sm">
                      <CheckSquare className="w-4 h-4 mr-2" /> Add Task
                    </Button>
                    <Button className="w-full justify-start bg-white hover:bg-indigo-50 text-indigo-700 border border-indigo-200 shadow-sm">
                      <Pencil className="w-4 h-4 mr-2" /> Add Note
                    </Button>
                  </div>
                </div>

                <Card className="border-slate-200 shadow-sm">
                  <CardHeader className="pb-4">
                    <CardTitle className="text-base font-semibold text-slate-900">Contact & Links</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-center gap-3 text-sm">
                      <Globe className="w-4 h-4 text-slate-400" />
                      <a href="#" className="text-indigo-600 hover:underline">chanzuckerberg.com</a>
                    </div>
                    <div className="flex items-center gap-3 text-sm">
                      <LinkIcon className="w-4 h-4 text-slate-400" />
                      <a href="#" className="text-indigo-600 hover:underline">LinkedIn Profile</a>
                    </div>
                    <Separator />
                    <div className="flex items-start gap-3 text-sm">
                      <MapPin className="w-4 h-4 text-slate-400 mt-0.5" />
                      <span className="text-slate-700">801 Jefferson Ave<br />Redwood City, CA 94063<br />United States</span>
                    </div>
                    <div className="flex items-center gap-3 text-sm">
                      <Phone className="w-4 h-4 text-slate-400" />
                      <span className="text-slate-700">(650) 555-0198</span>
                    </div>
                    <div className="flex items-center gap-3 text-sm">
                      <Mail className="w-4 h-4 text-slate-400" />
                      <a href="#" className="text-indigo-600 hover:underline">grants@chanzuckerberg.com</a>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </TabsContent>

          {/* GIVING TAB */}
          <TabsContent value="giving" className="focus-visible:outline-none">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-slate-900">Giving & Opportunities</h2>
                <p className="text-sm text-slate-500">Open asks, pledges, and gift history for this funder.</p>
              </div>
              <div className="flex gap-3">
                <Button className="bg-indigo-600 hover:bg-indigo-700 text-white">
                  <Plus className="w-4 h-4 mr-2" /> Add Opportunity
                </Button>
                <Button variant="outline">
                  <Plus className="w-4 h-4 mr-2" /> Add Gift
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4 mb-6">
              {[
                { label: "Lifetime Giving", value: "$1,475,000" },
                { label: "Open Pipeline", value: "$550,000" },
                { label: "Pledged, Unpaid", value: "$125,000" },
              ].map((s) => (
                <div key={s.label} className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="text-xs font-medium text-slate-500 mb-1">{s.label}</div>
                  <div className="text-xl font-semibold text-slate-900">{s.value}</div>
                </div>
              ))}
            </div>

            <div className="bg-white border border-slate-200 rounded-xl mb-6 overflow-hidden">
              <div className="px-5 py-3 border-b bg-slate-50/50 text-sm font-semibold text-slate-700">Opportunities & Pledges</div>
              {[
                { name: "FY27 General Operating Ask", stage: "Open", stageCls: "bg-sky-50 text-sky-700 border-sky-200", amount: "$400,000", detail: "Expected close Oct 2026 · 50% probability" },
                { name: "Massachusetts Expansion Grant", stage: "Pledge", stageCls: "bg-amber-50 text-amber-700 border-amber-200", amount: "$250,000", detail: "$125,000 paid · grant letter on file" },
                { name: "Teacher Leadership Initiative", stage: "Cash In", stageCls: "bg-emerald-50 text-emerald-700 border-emerald-200", amount: "$150,000", detail: "Fully paid Mar 2026" },
              ].map((o) => (
                <div key={o.name} className="px-5 py-3.5 border-b last:border-b-0 flex items-center justify-between hover:bg-slate-50 transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`text-xs font-medium border rounded-full px-2.5 py-0.5 shrink-0 ${o.stageCls}`}>{o.stage}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{o.name}</div>
                      <div className="text-xs text-slate-500">{o.detail}</div>
                    </div>
                  </div>
                  <div className="text-sm font-semibold text-slate-900 shrink-0 ml-4">{o.amount}</div>
                </div>
              ))}
            </div>

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b bg-slate-50/50 text-sm font-semibold text-slate-700">Recent Gifts & Payments</div>
              {[
                { name: "Payment 1 of 2 — MA Expansion Grant", date: "Jun 12, 2026", amount: "$125,000" },
                { name: "Teacher Leadership Initiative — Final Payment", date: "Mar 3, 2026", amount: "$75,000" },
                { name: "Teacher Leadership Initiative — First Payment", date: "Nov 20, 2025", amount: "$75,000" },
                { name: "FY25 General Operating Grant", date: "Sep 9, 2025", amount: "$500,000" },
              ].map((g) => (
                <div key={g.name + g.date} className="px-5 py-3.5 border-b last:border-b-0 flex items-center justify-between hover:bg-slate-50 transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                      <DollarSign className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{g.name}</div>
                      <div className="text-xs text-slate-500">{g.date}</div>
                    </div>
                  </div>
                  <div className="text-sm font-semibold text-slate-900 shrink-0 ml-4">{g.amount}</div>
                </div>
              ))}
            </div>
          </TabsContent>

          {/* PEOPLE TAB */}
          <TabsContent value="people" className="focus-visible:outline-none">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-slate-900">People & Affiliations</h2>
                <p className="text-sm text-slate-500">Staff, board members, and key contacts.</p>
              </div>
              <Button className="bg-indigo-600 hover:bg-indigo-700 text-white">
                <Plus className="w-4 h-4 mr-2" /> Add Person Role
              </Button>
            </div>
            
            <div className="space-y-4">
              {[
                { name: "Priscilla Chan", role: "Co-Founder & Co-CEO", status: "Active", initials: "PC" },
                { name: "Mark Zuckerberg", role: "Co-Founder & Co-CEO", status: "Active", initials: "MZ" },
                { name: "Sandra Taylor", role: "Director of Education", status: "Active", initials: "ST" },
              ].map((person, i) => (
                <div key={i} className="flex items-center justify-between p-4 bg-white border border-slate-200 rounded-lg hover:border-indigo-200 hover:shadow-sm transition-all group">
                  <div className="flex items-center gap-4">
                    <Avatar>
                      <AvatarFallback className="bg-indigo-100 text-indigo-700 font-medium">{person.initials}</AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="font-semibold text-slate-900 flex items-center gap-2">
                        {person.name}
                        <Badge variant="secondary" className="bg-green-50 text-green-700 hover:bg-green-50 text-[10px] uppercase tracking-wider py-0 px-1.5 h-4">Active</Badge>
                      </div>
                      <div className="text-sm text-slate-500">{person.role}</div>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" className="opacity-0 group-hover:opacity-100">
                    View Record <ArrowUpRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              ))}
            </div>
          </TabsContent>

          {/* ACTIVITY TAB */}
          <TabsContent value="activity" className="focus-visible:outline-none">
            <div className="grid grid-cols-12 gap-8">
              <div className="col-span-8">
                <div className="mb-6 flex items-center justify-between">
                  <h2 className="text-xl font-semibold text-slate-900">Activity Feed</h2>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="bg-white">
                      <MessageSquare className="w-4 h-4 mr-2" /> Log Interaction
                    </Button>
                    <Button variant="outline" size="sm" className="bg-white">
                      <Pencil className="w-4 h-4 mr-2" /> Add Note
                    </Button>
                  </div>
                </div>

                <div className="relative pl-6 space-y-8 before:absolute before:inset-0 before:left-[11px] before:w-px before:bg-slate-200">
                  {/* Item 1 */}
                  <div className="relative">
                    <div className="absolute -left-[35px] w-6 h-6 rounded-full bg-indigo-100 border-2 border-white flex items-center justify-center text-indigo-600">
                      <MessageSquare className="w-3 h-3" />
                    </div>
                    <Card className="border-slate-200 shadow-sm">
                      <CardHeader className="pb-3 pt-4">
                        <div className="flex justify-between items-start">
                          <div>
                            <CardTitle className="text-base font-medium text-slate-900">Initial Discovery Call</CardTitle>
                            <CardDescription className="text-sm mt-1">Logged by Sarah Jenkins with Sandra Taylor</CardDescription>
                          </div>
                          <span className="text-xs text-slate-500 font-medium">Oct 12, 2023</span>
                        </div>
                      </CardHeader>
                      <CardContent className="text-sm text-slate-700">
                        Great introductory conversation. Sandra emphasized their renewed focus on teacher well-being and retention. I shared our recent data on how the Wildflower model impacts teacher satisfaction. They are requesting a formal concept note by end of Q4.
                      </CardContent>
                    </Card>
                  </div>

                  {/* Item 2 */}
                  <div className="relative">
                    <div className="absolute -left-[35px] w-6 h-6 rounded-full bg-slate-100 border-2 border-white flex items-center justify-center text-slate-600">
                      <History className="w-3 h-3" />
                    </div>
                    <Card className="border-slate-200 shadow-sm bg-slate-50/50">
                      <CardHeader className="py-3 px-4">
                        <div className="flex justify-between items-center">
                          <div className="text-sm text-slate-700">
                            <span className="font-medium text-slate-900">Sarah Jenkins</span> changed Priority from <span className="line-through text-slate-400">Medium</span> to <span className="font-medium text-slate-900">High</span>
                          </div>
                          <span className="text-xs text-slate-500 font-medium">Oct 13, 2023</span>
                        </div>
                      </CardHeader>
                    </Card>
                  </div>
                </div>
              </div>

              <div className="col-span-4">
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 sticky top-24">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">Open Tasks</h3>
                    <Button variant="ghost" size="sm" className="h-8 px-2 text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50">
                      <Plus className="w-4 h-4 mr-1" /> Add
                    </Button>
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-start gap-3 p-3 bg-white rounded-lg border border-slate-200 shadow-sm">
                      <div className="mt-0.5"><div className="w-4 h-4 rounded border border-slate-300"></div></div>
                      <div>
                        <div className="text-sm font-medium text-slate-900 leading-tight mb-1">Draft Concept Note</div>
                        <div className="text-xs text-red-600 font-medium flex items-center"><Target className="w-3 h-3 mr-1"/> Due Today</div>
                      </div>
                    </div>
                    <div className="flex items-start gap-3 p-3 bg-white rounded-lg border border-slate-200 shadow-sm">
                      <div className="mt-0.5"><div className="w-4 h-4 rounded border border-slate-300"></div></div>
                      <div>
                        <div className="text-sm font-medium text-slate-900 leading-tight mb-1">Send impact report PDF</div>
                        <div className="text-xs text-slate-500 font-medium flex items-center"><Target className="w-3 h-3 mr-1"/> Nov 15</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}

export default TabbedWorkspace;