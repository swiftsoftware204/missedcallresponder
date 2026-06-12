import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    // Verify webhook signature
    const signature = req.headers.get("x-mintbird-signature")
    const payload = await req.json()
    
    // Load MintBird config
    const { data: mintbirdConfig } = await supabase
      .from("system_config")
      .select("value")
      .eq("key", "mintbird_integration")
      .single()
    
    const config = mintbirdConfig?.value || {}
    
    // Verify signature (if secret is configured)
    if (config.webhook_secret && signature !== config.webhook_secret) {
      return new Response(
        JSON.stringify({ error: "Invalid signature" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    const eventType = payload.event_type || payload.type

    switch (eventType) {
      case "purchase.completed":
      case "order.paid":
        await handlePurchase(supabase, payload, config)
        break
      
      case "subscription.created":
        await handleSubscription(supabase, payload, config)
        break
      
      case "refund.processed":
        await handleRefund(supabase, payload)
        break
      
      default:
        console.log("Unhandled MintBird event:", eventType)
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    })

  } catch (error) {
    console.error("MintBird webhook error:", error)
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})

// Handle new purchase
async function handlePurchase(supabase: any, payload: any, config: any) {
  const customer = payload.customer || {}
  const order = payload.order || payload.purchase || {}
  const product = payload.product || {}
  
  const email = customer.email
  const firstName = customer.first_name || customer.name?.split(" ")[0] || ""
  const lastName = customer.last_name || customer.name?.split(" ").slice(1).join(" ") || ""
  const company = customer.company || ""
  const phone = customer.phone || ""
  
  // Map MintBird product to subscription plan
  const productMapping = config.product_mapping || {}
  const planName = productMapping[product.id] || productMapping[product.name] || "Starter"
  
  // Find or create tenant
  const { data: existingTenant } = await supabase
    .from("tenants")
    .select("id")
    .eq("email", email)
    .single()
  
  let tenantId = existingTenant?.id
  
  if (!tenantId) {
    // Create new tenant from MintBird purchase
    const { data: newTenant, error: tenantError } = await supabase
      .from("tenants")
      .insert({
        name: company || `${firstName} ${lastName}`,
        email,
        phone_number: phone,
        status: "active",
        plan: planName.toLowerCase(),
        settings: {
          source: "mintbird",
          mintbird_customer_id: customer.id,
          mintbird_order_id: order.id,
        },
      })
      .select()
      .single()
    
    if (tenantError) {
      console.error("Failed to create tenant from MintBird:", tenantError)
      return
    }
    
    tenantId = newTenant.id
    
    // Create full tenant setup
    await setupNewTenant(supabase, tenantId, planName)
  } else {
    // Update existing tenant
    await supabase
      .from("tenants")
      .update({
        plan: planName.toLowerCase(),
        status: "active",
        updated_at: new Date().toISOString(),
      })
      .eq("id", tenantId)
  }
  
  // Add credits based on plan
  const planCredits = getPlanCredits(planName)
  if (planCredits > 0) {
    await supabase.rpc("add_credits", {
      p_tenant_id: tenantId,
      p_amount: planCredits,
      p_description: `MintBird purchase - ${planName} plan`,
      p_metadata: { order_id: order.id, product_id: product.id }
    })
  }
  
  // Create or update subscription
  await supabase
    .from("tenant_subscriptions")
    .upsert({
      tenant_id: tenantId,
      status: "active",
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    })
  
  // Generate login credentials
  const tempPassword = generateTempPassword()
  
  // Create or update user
  const { data: existingUser } = await supabase
    .from("users")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("email", email)
    .single()
  
  if (!existingUser) {
    await supabase.from("users").insert({
      tenant_id: tenantId,
      email,
      first_name: firstName,
      last_name: lastName,
      role: "admin",
      status: "active",
    })
  }
  
  // Send welcome email with credentials
  await sendMintBirdWelcomeEmail(supabase, {
    email,
    first_name: firstName,
    tenant_id: tenantId,
    temp_password: tempPassword,
    plan_name: planName,
    order_id: order.id,
  })
  
  console.log("MintBird purchase processed:", tenantId)
}

// Handle subscription events
async function handleSubscription(supabase: any, payload: any, config: any) {
  const subscription = payload.subscription || {}
  const customer = payload.customer || {}
  
  // Find tenant by MintBird customer ID
  const { data: tenant } = await supabase
    .from("tenants")
    .select("id")
    .eq("settings->>mintbird_customer_id", customer.id)
    .single()
  
  if (tenant) {
    await supabase
      .from("tenant_subscriptions")
      .upsert({
        tenant_id: tenant.id,
        stripe_subscription_id: subscription.id,
        status: subscription.status,
        current_period_start: subscription.current_period_start,
        current_period_end: subscription.current_period_end,
      })
  }
}

// Handle refunds
async function handleRefund(supabase: any, payload: any) {
  const orderId = payload.order?.id || payload.purchase?.id
  
  // Find tenant by order ID
  const { data: tenant } = await supabase
    .from("tenants")
    .select("id")
    .eq("settings->>mintbird_order_id", orderId)
    .single()
  
  if (tenant) {
    // Suspend tenant
    await supabase
      .from("tenants")
      .update({ status: "suspended" })
      .eq("id", tenant.id)
    
    // Log the refund
    await supabase.from("credit_transactions").insert({
      tenant_id: tenant.id,
      type: "refund",
      amount: 0,
      balance_after: 0,
      description: `Refund processed for order ${orderId}`,
    })
  }
}

// Setup new tenant with all required records
async function setupNewTenant(supabase: any, tenantId: string, planName: string) {
  // Create LLM settings
  await supabase.from("tenant_llm_settings").insert({
    tenant_id: tenantId,
    use_own_key: false,
    provider: "groq",
    model: "llama3-70b-8192",
  })
  
  // Create credit balance
  await supabase.from("credit_balances").insert({
    tenant_id: tenantId,
    balance: 0,
  })
  
  // Create notification settings
  await supabase.from("notification_settings").insert({
    tenant_id: tenantId,
    email_notifications: true,
    sms_notifications: false,
  })
}

// Get plan credits
function getPlanCredits(planName: string): number {
  const credits: Record<string, number> = {
    "starter": 500,
    "growth": 1500,
    "pro": 5000,
  }
  return credits[planName.toLowerCase()] || 500
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

// Load email template from system config
async function loadEmailTemplate(supabase: any, templateKey: string) {
  const { data: config } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", "email_templates")
    .single()
  
  const templates = config?.value || {}
  return templates[templateKey] || templates["default_welcome"]
}

// Send welcome email with custom SMTP
async function sendMintBirdWelcomeEmail(supabase: any, data: any) {
  // Load branding and email config
  const branding = await loadSystemConfig(supabase, "branding")
  const smtpSettings = await loadSystemConfig(supabase, "smtp_settings")
  const emailTemplate = await loadEmailTemplate(supabase, "mintbird_welcome")
  
  const appName = branding?.app_name || "Missed Call Responder"
  const fromEmail = smtpSettings?.from_email || "notifications@missedcallresponder.com"
  const fromName = smtpSettings?.from_name || appName
  
  // Use custom template or default
  const template = emailTemplate || {
    subject: `Welcome to ${appName} - Your Account is Ready!`,
    body: `Hi {{first_name}},

Thank you for purchasing {{plan_name}}!

Your account has been created and is ready to use.

Login Details:
- Email: {{email}}
- Temporary Password: {{temp_password}}
- Dashboard: https://missedcallresponder.netlify.com/login

Order ID: {{order_id}}

Please change your password after your first login.

Best regards,
{{app_name}} Team`
  }
  
  // Replace variables
  const emailBody = template.body
    .replace(/{{first_name}}/g, data.first_name)
    .replace(/{{email}}/g, data.email)
    .replace(/{{temp_password}}/g, data.temp_password)
    .replace(/{{plan_name}}/g, data.plan_name)
    .replace(/{{order_id}}/g, data.order_id)
    .replace(/{{app_name}}/g, appName)
  
  // Queue email
  await supabase.from("notification_queue").insert({
    tenant_id: data.tenant_id,
    type: "email",
    recipient: data.email,
    subject: template.subject.replace(/{{app_name}}/g, appName).replace(/{{plan_name}}/g, data.plan_name),
    content: emailBody,
  })
}

// Load system config helper
async function loadSystemConfig(supabase: any, key: string) {
  const { data: config } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", key)
    .single()
  return config?.value
}
