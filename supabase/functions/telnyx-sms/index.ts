import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

// Platform Telnyx API configuration (for non-BYOK tenants)
const PLATFORM_TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY") ?? ""
const TELNYX_API_BASE = "https://api.telnyx.com/v2"

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    const { to, message, tenant_id, lead_id } = await req.json()

    // Validate required fields
    if (!to || !message || !tenant_id) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: to, message, tenant_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Get tenant's SMS settings and phone number
    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("phone_number, id")
      .eq("id", tenant_id)
      .single()

    if (tenantError || !tenant?.phone_number) {
      return new Response(
        JSON.stringify({ error: "Tenant phone number not configured" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Get tenant SMS settings (BYOK check)
    const { data: smsSettings, error: smsSettingsError } = await supabase
      .from("tenant_sms_settings")
      .select("use_own_telnyx_key, telnyx_api_key_encrypted, fallback_to_platform")
      .eq("tenant_id", tenant_id)
      .single()

    let apiKey = PLATFORM_TELNYX_API_KEY
    let fromNumber = tenant.phone_number
    let usingBYOK = false

    // Check if tenant has BYOK enabled
    if (smsSettings?.use_own_telnyx_key && smsSettings?.telnyx_api_key_encrypted) {
      // TODO: Decrypt the API key (implement decryption logic)
      // For now, we'll use platform key as fallback
      apiKey = PLATFORM_TELNYX_API_KEY
      usingBYOK = true
      console.log(`Tenant ${tenant_id} has BYOK enabled, but using platform key for now`)
    }

    // Send SMS via Telnyx
    let response
    let telnyxData
    let smsSuccess = false
    let errorMessage = ""

    try {
      response = await fetch(`${TELNYX_API_BASE}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromNumber,
          to: to,
          text: message,
        }),
      })

      telnyxData = await response.json()
      smsSuccess = response.ok

      if (!response.ok) {
        errorMessage = telnyxData.errors?.[0]?.detail || "Failed to send SMS"
        console.error("Telnyx API error:", errorMessage)
      }
    } catch (apiError) {
      errorMessage = apiError.message
      console.error("Telnyx API exception:", apiError)
    }

    // If BYOK failed and fallback is enabled, try platform account
    if (!smsSuccess && usingBYOK && smsSettings?.fallback_to_platform) {
      console.log(`BYOK failed for tenant ${tenant_id}, falling back to platform account`)
      
      // Get platform-managed number for this tenant
      const { data: poolNumber } = await supabase
        .from("phone_number_pool")
        .select("phone_number")
        .eq("tenant_id", tenant_id)
        .eq("status", "assigned")
        .single()

      if (poolNumber?.phone_number) {
        try {
          response = await fetch(`${TELNYX_API_BASE}/messages`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${PLATFORM_TELNYX_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: poolNumber.phone_number,
              to: to,
              text: message,
            }),
          })

          telnyxData = await response.json()
          smsSuccess = response.ok
          fromNumber = poolNumber.phone_number

          if (!response.ok) {
            errorMessage = telnyxData.errors?.[0]?.detail || "Fallback SMS also failed"
          }
        } catch (fallbackError) {
          errorMessage = fallbackError.message
        }
      }
    }

    if (!smsSuccess) {
      return new Response(
        JSON.stringify({ error: errorMessage }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Deduct credits if using platform account (not BYOK)
    if (!usingBYOK || fromNumber !== tenant.phone_number) {
      const { data: creditCost } = await supabase
        .from("system_config")
        .select("value")
        .eq("key", "credit_costs")
        .single()

      const smsCost = creditCost?.value?.sms ?? 1

      // Deduct credits
      await supabase.rpc("deduct_credits", {
        p_tenant_id: tenant_id,
        p_amount: smsCost,
        p_description: `SMS sent to ${to}`,
        p_metadata: { to, message_preview: message.substring(0, 50) }
      })
    }

    // Log message to database
    const { data: messageLog, error: logError } = await supabase
      .from("messages")
      .insert({
        tenant_id,
        lead_id: lead_id ?? null,
        direction: "outbound",
        body: message,
        status: telnyxData.data?.status || "sent",
        external_id: telnyxData.data?.id,
        from_number: fromNumber,
        to_number: to,
        sent_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (logError) {
      console.error("Failed to log message:", logError)
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        message_id: telnyxData.data?.id,
        status: telnyxData.data?.status,
        using_byok: usingBYOK && smsSuccess,
        from_number: fromNumber
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )

  } catch (error) {
    console.error("Error sending SMS:", error)
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})
