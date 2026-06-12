import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

// LLM Provider configurations - base URLs only, models from system config
const LLM_PROVIDERS = {
  groq: { baseUrl: "https://api.groq.com/openai/v1" },
  openai: { baseUrl: "https://api.openai.com/v1" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1" },
}

// Load available providers and models from system config
async function loadLLMConfig(supabase: any) {
  const { data: config } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", "llm_providers")
    .single()
  
  return config?.value || LLM_PROVIDERS
}

// Credit costs - loaded from system config
let CREDIT_COSTS: any = null

async function loadCreditCosts(supabase: any) {
  if (CREDIT_COSTS) return CREDIT_COSTS
  
  const { data: config } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", "credit_costs")
    .single()
  
  CREDIT_COSTS = config?.value || { sms: 1, ai_message: 5, appointment_booking: 3 }
  return CREDIT_COSTS
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

    const { tenant_id, lead_id, phone_number, message, conversation_id } = await req.json()

    if (!tenant_id || !phone_number || !message) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Get tenant LLM settings
    const { data: llmSettings, error: settingsError } = await supabase
      .from("tenant_llm_settings")
      .select("*")
      .eq("tenant_id", tenant_id)
      .single()

    if (settingsError) {
      return new Response(
        JSON.stringify({ error: "LLM settings not found" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Get or create conversation
    let conversation = null
    if (conversation_id) {
      const { data: existingConv } = await supabase
        .from("llm_conversations")
        .select("*")
        .eq("id", conversation_id)
        .single()
      conversation = existingConv
    }

    if (!conversation) {
      // Check for active conversation
      const { data: activeConv } = await supabase
        .from("llm_conversations")
        .select("*")
        .eq("tenant_id", tenant_id)
        .eq("phone_number", phone_number)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .single()
      
      conversation = activeConv
    }

    // Create new conversation if none exists
    if (!conversation) {
      const { data: newConv, error: convError } = await supabase
        .from("llm_conversations")
        .insert({
          tenant_id,
          lead_id: lead_id ?? null,
          phone_number,
          status: "active",
          context: [],
        })
        .select()
        .single()
      
      if (convError) {
        return new Response(
          JSON.stringify({ error: "Failed to create conversation" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        )
      }
      conversation = newConv
    }

    // Build conversation context
    const context = conversation.context || []
    context.push({ role: "user", content: message })

    // Load credit costs from config
    const creditCosts = await loadCreditCosts(supabase)
    
    // Check credit balance if not using BYOK
    let usingCredits = false
    let apiKey = ""
    let provider = llmSettings.provider
    let model = llmSettings.model

    if (!llmSettings.use_own_key || !llmSettings.api_key_encrypted) {
      // Use credits
      usingCredits = true
      
      // Check balance
      const { data: creditBalance } = await supabase
        .from("credit_balances")
        .select("balance")
        .eq("tenant_id", tenant_id)
        .single()

      if (!creditBalance || creditBalance.balance < creditCosts.ai_message) {
        // Send low credit notification
        await sendLowCreditNotification(supabase, tenant_id)
        
        return new Response(
          JSON.stringify({ 
            error: "Insufficient credits",
            response: "I apologize, but we're unable to process your request at this time. Please contact the business directly."
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        )
      }

      // Use system API key
      apiKey = getSystemApiKey(provider)
    } else {
      // Use tenant's API key
      apiKey = decryptApiKey(llmSettings.api_key_encrypted)
    }

    // Call LLM
    const aiResponse = await callLLM(provider, model, apiKey, context, llmSettings.system_prompt)

    if (!aiResponse) {
      // Try fallback if enabled
      if (llmSettings.fallback_to_credits && !usingCredits) {
        provider = llmSettings.fallback_provider
        model = llmSettings.fallback_model
        apiKey = getSystemApiKey(provider)
        usingCredits = true
        
        const fallbackResponse = await callLLM(provider, model, apiKey, context, llmSettings.system_prompt)
        if (fallbackResponse) {
          aiResponse.content = fallbackResponse.content
        }
      }
      
      if (!aiResponse) {
        return new Response(
          JSON.stringify({ error: "AI service unavailable" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        )
      }
    }

    // Deduct credits if using them
    if (usingCredits) {
      const { data: deductSuccess } = await supabase.rpc("deduct_credits", {
        p_tenant_id: tenant_id,
        p_amount: creditCosts.ai_message,
        p_description: `AI conversation - ${provider}/${model}`,
        p_metadata: { conversation_id: conversation.id, provider, model }
      })

      if (!deductSuccess) {
        console.error("Failed to deduct credits for tenant:", tenant_id)
      }

      // Log usage
      await supabase.rpc("log_usage", {
        p_tenant_id: tenant_id,
        p_service_type: "ai_conversation",
        p_credits_used: creditCosts.ai_message,
        p_metadata: { conversation_id: conversation.id, provider, model }
      })
    }

    // Update conversation context
    context.push({ role: "assistant", content: aiResponse.content })
    
    // Check for appointment intent
    const appointmentDetails = extractAppointmentIntent(aiResponse.content)
    
    await supabase
      .from("llm_conversations")
      .update({
        context: context.slice(-20), // Keep last 20 messages
        last_message_at: new Date().toISOString(),
        credits_used: conversation.credits_used + (usingCredits ? creditCosts.ai_message : 0),
        tokens_used: conversation.tokens_used + (aiResponse.tokens || 0),
        provider_used: provider,
        model_used: model,
        appointment_requested: appointmentDetails.requested,
        appointment_details: appointmentDetails.details,
      })
      .eq("id", conversation.id)

    // Send notification to client
    await notifyClient(supabase, tenant_id, {
      type: "ai_conversation",
      phone_number,
      message_preview: message.substring(0, 100),
      ai_response: aiResponse.content.substring(0, 100),
    })

    return new Response(
      JSON.stringify({
        success: true,
        response: aiResponse.content,
        conversation_id: conversation.id,
        credits_used: usingCredits ? creditCosts.ai_message : 0,
        provider,
        model,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )

  } catch (error) {
    console.error("AI conversation error:", error)
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})

// Call LLM API
async function callLLM(provider: string, model: string, apiKey: string, context: any[], systemPrompt: string) {
  try {
    const providerConfig = LLM_PROVIDERS[provider as keyof typeof LLM_PROVIDERS]
    if (!providerConfig) return null

    let requestBody: any
    let headers: any = {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    }

    if (provider === "anthropic") {
      headers["x-api-key"] = apiKey
      headers["anthropic-version"] = "2023-06-01"
      requestBody = {
        model: model,
        max_tokens: 500,
        messages: [
          { role: "system", content: systemPrompt },
          ...context
        ]
      }
    } else {
      // OpenAI/Groq format
      requestBody = {
        model: model,
        messages: [
          { role: "system", content: systemPrompt },
          ...context
        ],
        max_tokens: 500,
        temperature: 0.7,
      }
    }

    const response = await fetch(`${providerConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      console.error(`${provider} API error:`, await response.text())
      return null
    }

    const data = await response.json()
    
    return {
      content: data.choices?.[0]?.message?.content || data.content?.[0]?.text,
      tokens: data.usage?.total_tokens || 0,
    }
  } catch (error) {
    console.error(`Error calling ${provider}:`, error)
    return null
  }
}

// Get system API key for credit-based usage
function getSystemApiKey(provider: string): string {
  const envVar = `${provider.toUpperCase()}_API_KEY`
  return Deno.env.get(envVar) ?? ""
}

// Decrypt tenant API key (simplified - use proper encryption in production)
function decryptApiKey(encrypted: string): string {
  // TODO: Implement proper decryption
  return encrypted
}

// Extract appointment intent from AI response
function extractAppointmentIntent(response: string): { requested: boolean; details?: any } {
  const lowerResponse = response.toLowerCase()
  const appointmentKeywords = [
    "schedule", "appointment", "book", "available", "time slot",
    "meet", "call", "consultation", "when works for you"
  ]
  
  const requested = appointmentKeywords.some(keyword => lowerResponse.includes(keyword))
  
  // Extract potential dates/times (simplified)
  const datePattern = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi
  const timePattern = /\b(\d{1,2}:\d{2}\s*(am|pm)?|\d{1,2}\s*(am|pm))\b/gi
  
  const dates = response.match(datePattern) || []
  const times = response.match(timePattern) || []
  
  return {
    requested,
    details: requested ? { dates, times } : undefined
  }
}

// Send low credit notification
async function sendLowCreditNotification(supabase: any, tenantId: string) {
  // Get notification settings
  const { data: settings } = await supabase
    .from("notification_settings")
    .select("*")
    .eq("tenant_id", tenantId)
    .single()

  if (settings?.notify_on_low_credits) {
    await supabase.from("notification_queue").insert({
      tenant_id: tenantId,
      type: "email",
      recipient: settings.notification_email,
      subject: "Low Credit Balance Alert",
      content: "Your credit balance is running low. Please add more credits to avoid service interruption.",
    })
  }
}

// Notify client of activity
async function notifyClient(supabase: any, tenantId: string, data: any) {
  const { data: settings } = await supabase
    .from("notification_settings")
    .select("*")
    .eq("tenant_id", tenantId)
    .single()

  if (!settings) return

  // Email notification
  if (settings.email_notifications && settings.notification_email) {
    await supabase.from("notification_queue").insert({
      tenant_id: tenantId,
      type: "email",
      recipient: settings.notification_email,
      subject: `New ${data.type}: ${data.phone_number}`,
      content: `Activity detected:\nPhone: ${data.phone_number}\nMessage: ${data.message_preview}\nAI Response: ${data.ai_response}`,
    })
  }

  // SMS notification
  if (settings.sms_notifications && settings.notification_phone) {
    await supabase.from("notification_queue").insert({
      tenant_id: tenantId,
      type: "sms",
      recipient: settings.notification_phone,
      content: `New lead activity from ${data.phone_number}. Check your dashboard for details.`,
    })
  }
}
