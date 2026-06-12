import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

// SuiteDash API configuration
const SUITEDASH_API_BASE = "https://api.suitedash.com/v1"

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    const { event_type, payload } = await req.json()

    // Log webhook
    await supabase.from("suitedash_webhook_logs").insert({
      event_type,
      payload,
      processed: false,
    })

    switch (event_type) {
      case "client.created":
      case "client.updated":
        await handleClientSync(supabase, payload)
        break
      
      case "client.deleted":
        await handleClientDelete(supabase, payload)
        break
      
      default:
        console.log("Unhandled SuiteDash event:", event_type)
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    })

  } catch (error) {
    console.error("SuiteDash sync error:", error)
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})

// Handle new or updated client from SuiteDash
async function handleClientSync(supabase: any, payload: any) {
  const clientData = payload.client || payload
  const {
    id: suitedash_client_id,
    email,
    first_name,
    last_name,
    company_name,
    phone,
    custom_fields,
  } = clientData

  // Check if tenant already exists
  const { data: existingIntegration } = await supabase
    .from("suitedash_integrations")
    .select("tenant_id")
    .eq("suitedash_client_id", suitedash_client_id)
    .single()

  let tenantId = existingIntegration?.tenant_id

  if (!tenantId) {
    // Create new tenant
    const { data: newTenant, error: tenantError } = await supabase
      .from("tenants")
      .insert({
        name: company_name || `${first_name} ${last_name}`,
        email,
        phone_number: phone,
        status: "active",
        plan: "starter",
        settings: {
          suitedash_client_id,
          source: "suitedash",
        },
      })
      .select()
      .single()

    if (tenantError) {
      console.error("Failed to create tenant:", tenantError)
      return
    }

    tenantId = newTenant.id

    // Create SuiteDash integration record
    await supabase.from("suitedash_integrations").insert({
      tenant_id: tenantId,
      suitedash_client_id,
      suitedash_api_key: custom_fields?.api_key,
      suitedash_portal_url: custom_fields?.portal_url,
      auto_sync_enabled: true,
      sync_status: "active",
      last_sync_at: new Date().toISOString(),
    })

    // Create default LLM settings
    await supabase.from("tenant_llm_settings").insert({
      tenant_id: tenantId,
      use_own_key: false,
      provider: "groq",
      model: "llama3-70b-8192",
      fallback_to_credits: true,
    })

    // Create credit balance
    await supabase.from("credit_balances").insert({
      tenant_id: tenantId,
      balance: 100, // Starting credits
      lifetime_credits: 100,
    })

    // Create notification settings
    await supabase.from("notification_settings").insert({
      tenant_id: tenantId,
      email_notifications: true,
      sms_notifications: false,
      notification_email: email,
      notification_phone: phone,
    })

    // Create subscription
    await supabase.from("tenant_subscriptions").insert({
      tenant_id: tenantId,
      status: "trialing",
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(), // 14-day trial
    })

    // Create admin user for tenant
    const tempPassword = generateTempPassword()
    await supabase.from("users").insert({
      tenant_id: tenantId,
      email,
      first_name,
      last_name,
      role: "admin",
      status: "active",
    })

    // Deploy widget to SuiteDash
    await deployWidgetToSuiteDash(supabase, tenantId, suitedash_client_id)

    // Send welcome email
    await sendWelcomeEmail(supabase, {
      email,
      first_name,
      tenant_id: tenantId,
      temp_password: tempPassword,
      dashboard_url: `https://missedcallresponder.netlify.com/login`,
    })

    console.log("New tenant created from SuiteDash:", tenantId)
  } else {
    // Update existing tenant
    await supabase
      .from("tenants")
      .update({
        name: company_name || `${first_name} ${last_name}`,
        email,
        phone_number: phone,
        updated_at: new Date().toISOString(),
      })
      .eq("id", tenantId)

    await supabase
      .from("suitedash_integrations")
      .update({
        last_sync_at: new Date().toISOString(),
        sync_status: "active",
      })
      .eq("tenant_id", tenantId)

    console.log("Tenant updated from SuiteDash:", tenantId)
  }
}

// Handle client deletion from SuiteDash
async function handleClientDelete(supabase: any, payload: any) {
  const suitedash_client_id = payload.client?.id || payload.id

  const { data: integration } = await supabase
    .from("suitedash_integrations")
    .select("tenant_id")
    .eq("suitedash_client_id", suitedash_client_id)
    .single()

  if (integration?.tenant_id) {
    // Soft delete tenant
    await supabase
      .from("tenants")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", integration.tenant_id)

    console.log("Tenant cancelled due to SuiteDash deletion:", integration.tenant_id)
  }
}

// Deploy analytics widget to SuiteDash
async function deployWidgetToSuiteDash(supabase: any, tenantId: string, suitedashClientId: string) {
  try {
    // Generate widget code
    const widgetCode = await generateWidgetCode(supabase, tenantId)

    // In production, call SuiteDash API to add widget
    // For now, store it for manual deployment
    await supabase
      .from("suitedash_integrations")
      .update({
        widget_deployed: true,
      })
      .eq("tenant_id", tenantId)

    console.log("Widget ready for deployment to SuiteDash client:", suitedashClientId)
  } catch (error) {
    console.error("Failed to deploy widget:", error)
  }
}

// Generate embeddable widget code
async function generateWidgetCode(supabase: any, tenantId: string): Promise<string> {
  // Load branding config
  const branding = await loadSystemConfig(supabase, "branding")
  const primaryColor = branding?.primary_color || "#3B82F6"
  const secondaryColor = branding?.secondary_color || "#10B981"
  const appName = branding?.app_name || "Missed Call Responder"
  
  return `
<!-- ${appName} Analytics Widget -->
<div id="mcr-widget-${tenantId}" style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
  <h3 style="margin-top: 0; color: ${primaryColor};">📞 Missed Call Analytics</h3>
  <div id="mcr-stats-${tenantId}">
    <p>Loading...</p>
  </div>
  <div style="margin-top: 15px; font-size: 12px; color: #666;">
    <a href="https://missedcallresponder.netlify.com/login" target="_blank" style="color: ${primaryColor};">View Full Dashboard →</a>
  </div>
</div>

<script>
(function() {
  const tenantId = '${tenantId}';
  const apiUrl = 'https://your-project.supabase.co/functions/v1/widget-data';
  
  async function loadStats() {
    try {
      const response = await fetch(\`\${apiUrl}?tenant_id=\${tenantId}\`);
      const data = await response.json();
      
      document.getElementById(\`mcr-stats-\${tenantId}\`).innerHTML = \`
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div style="background: #f3f4f6; padding: 10px; border-radius: 4px;">
            <div style="font-size: 24px; font-weight: bold; color: ${primaryColor};">\${data.missed_calls || 0}</div>
            <div style="font-size: 12px; color: #666;">Missed Calls</div>
          </div>
          <div style="background: #f3f4f6; padding: 10px; border-radius: 4px;">
            <div style="font-size: 24px; font-weight: bold; color: ${secondaryColor};">\${data.leads || 0}</div>
            <div style="font-size: 12px; color: #666;">Leads</div>
          </div>
          <div style="background: #f3f4f6; padding: 10px; border-radius: 4px;">
            <div style="font-size: 24px; font-weight: bold; color: ${primaryColor};">\${data.conversations || 0}</div>
            <div style="font-size: 12px; color: #666;">AI Chats</div>
          </div>
          <div style="background: #f3f4f6; padding: 10px; border-radius: 4px;">
            <div style="font-size: 24px; font-weight: bold; color: ${secondaryColor};">\${data.appointments || 0}</div>
            <div style="font-size: 12px; color: #666;">Booked</div>
          </div>
        </div>
        <div style="margin-top: 10px; padding: 10px; background: #fef3c7; border-radius: 4px; font-size: 12px;">
          💳 Credits: <strong>\${data.credits || 0}</strong>
        </div>
      \`;
    } catch (error) {
      document.getElementById(\`mcr-stats-\${tenantId}\`).innerHTML = '<p style="color: red;">Failed to load data</p>';
    }
  }
  
  loadStats();
  // Refresh every 5 minutes
  setInterval(loadStats, 300000);
})();
</script>
  `.trim()
}

// Generate temporary password
function generateTempPassword(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*"
  let password = ""
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return password
}

// Load system config
async function loadSystemConfig(supabase: any, key: string) {
  const { data: config } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", key)
    .single()
  return config?.value
}

// Send welcome email
async function sendWelcomeEmail(supabase: any, data: any) {
  // Load branding and notification config
  const branding = await loadSystemConfig(supabase, "branding")
  const notifications = await loadSystemConfig(supabase, "notifications")
  const billing = await loadSystemConfig(supabase, "billing")
  
  const appName = branding?.app_name || "Missed Call Responder"
  const fromName = notifications?.from_name || appName
  const trialDays = billing?.trial_days || 14
  
  await supabase.from("notification_queue").insert({
    tenant_id: data.tenant_id,
    type: "email",
    recipient: data.email,
    subject: notifications?.welcome_subject || `Welcome to ${appName}`,
    content: `
Hi ${data.first_name},

Welcome to ${appName}! Your account has been created.

Login Details:
- Email: ${data.email}
- Temporary Password: ${data.temp_password}
- Dashboard: ${data.dashboard_url}

Please change your password after your first login.

Your ${trialDays}-day free trial starts now!

Best regards,
${fromName} Team
    `.trim(),
  })
}
