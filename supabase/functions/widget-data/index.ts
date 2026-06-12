import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    const tenantId = url.searchParams.get("tenant_id")

    if (!tenantId) {
      return new Response(
        JSON.stringify({ error: "Missing tenant_id parameter" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    // Get today's stats
    const today = new Date().toISOString().split("T")[0]
    const todayStart = `${today}T00:00:00.000Z`
    const todayEnd = `${today}T23:59:59.999Z`

    // Missed calls today
    const { count: missedCalls } = await supabase
      .from("calls")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("status", "missed")
      .gte("created_at", todayStart)
      .lte("created_at", todayEnd)

    // Total leads
    const { count: totalLeads } = await supabase
      .from("leads")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", tenantId)

    // New leads today
    const { count: newLeads } = await supabase
      .from("leads")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .gte("created_at", todayStart)
      .lte("created_at", todayEnd)

    // AI conversations today
    const { count: conversations } = await supabase
      .from("llm_conversations")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .gte("created_at", todayStart)
      .lte("created_at", todayEnd)

    // Appointments booked
    const { count: appointments } = await supabase
      .from("llm_conversations")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("appointment_booked", true)
      .gte("created_at", todayStart)
      .lte("created_at", todayEnd)

    // Credit balance
    const { data: creditBalance } = await supabase
      .from("credit_balances")
      .select("balance")
      .eq("tenant_id", tenantId)
      .single()

    // Response rate (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { count: totalCalls } = await supabase
      .from("calls")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .gte("created_at", sevenDaysAgo)

    const { count: respondedCalls } = await supabase
      .from("calls")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("sms_sent", true)
      .gte("created_at", sevenDaysAgo)

    const responseRate = totalCalls > 0 
      ? Math.round((respondedCalls / totalCalls) * 100) 
      : 0

    // Recent activity
    const { data: recentActivity } = await supabase
      .from("calls")
      .select("from_number, created_at, status")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(5)

    return new Response(
      JSON.stringify({
        missed_calls: missedCalls || 0,
        leads: totalLeads || 0,
        new_leads_today: newLeads || 0,
        conversations: conversations || 0,
        appointments: appointments || 0,
        credits: creditBalance?.balance || 0,
        response_rate: responseRate,
        recent_activity: recentActivity || [],
        last_updated: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )

  } catch (error) {
    console.error("Widget data error:", error)
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})
