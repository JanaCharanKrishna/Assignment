import {
  IconChartBar,
  IconDatabase,
  IconInnerShadowTop,
  IconReport,
} from "@tabler/icons-react";
import { NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const data = {
  user: {
    name: "Assignment User",
    email: "local@dashboard",
    avatar: "/vite.svg",
  },
  navMain: [
    { title: "Dashboard", url: "/", icon: IconChartBar },
    { title: "Reports", url: "/reports", icon: IconReport },
    { title: "Data Library", url: "/datalibrary", icon: IconDatabase },
  ],
};

export function AppSidebar(props) {
  return (
    <Sidebar collapsible="offcanvas" className="border-r border-white/10" {...props}>
      <SidebarHeader className="px-4 pt-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="h-10 rounded-xl px-2">
              <a href="/" className="gap-2">
                <IconInnerShadowTop className="!size-5" />
                <span className="text-xl font-semibold tracking-tight">One-geo</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="px-2 pb-2">
        <NavMain items={data.navMain} />
      </SidebarContent>

      <SidebarFooter>
        <NavUser user={data.user} />
      </SidebarFooter>
    </Sidebar>
  );
}
