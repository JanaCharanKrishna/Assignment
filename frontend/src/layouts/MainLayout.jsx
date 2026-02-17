import { Outlet } from "react-router-dom";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

export default function MainLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-h-screen">
        <div className="fixed right-3 top-3 z-30 rounded-lg border border-white/10 bg-zinc-900/80 p-1 backdrop-blur">
          <SidebarTrigger className="size-8" />
        </div>
        <div className="p-3 md:p-5">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
