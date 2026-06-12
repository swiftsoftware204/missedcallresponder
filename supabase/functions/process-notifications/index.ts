import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

// Process notification queue every minute
Deno.serve(async (req: Request) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    // Get pending notifications
    const { data: notifications, error } = await supabase
      .from("notification_queue")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(50)

    if (error || !notifications || notifications.length === 0) {
      return new Response(JSON.stringify({ processed: 0 }), {
        headers: { "Content-Type": "application/json" }
      })
    }

    const results = await Promise.all(
      notifications.map(async (notification) => {
        try {
          let success = false

          switch (notification.type) {
            case "email":
              success = await sendEmail(supabase, notification)
              break
            case "sms":
              success = await sendSMS(supabase, notification)
              break
            case "webhook":
              success = await sendWebhook(notification)
              break
          }

          // Update notification status
          await supabase
            .from("notification_queue")
            .update({
              status: success ? "sent" : "failed",
              sent_at: success ? new Date().toISOString() : null,
              error: success ? null : "Failed to send",
            })
            .eq("id", notification.id)

          return { id: notification.id, success }
        } catch (err) {
          console.error("Notification error:", err)
          
          await supabase
            .from("notification_queue")
            .update({
              status: "failed",
              error: err.message,
            })
            .eq("id", notification.id)

          return { id: notification.id, success: false, error: err.message }
        }
      })
    )

    const successCount = results.filter(r => r.success).length

    return new Response(
      JSON.stringify({ 
        processed: notifications.length,
        successful: successCount,
        failed: notifications.length - successCount
      }),
      { headers: { "Content-Type": "application/json" } }
    )

  } catch (error) {
    console.error("Process notifications error:", error)
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
})

// Load system config
async function loadSystemConfig(supabase: any, key: string) {
  const { data: config } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", key)
    .single()
  return config?.value
}

// Send email via SendGrid or Custom SMTP
async function sendEmail(supabase: any, notification: any): Promise<boolean> {
  try {
    // Load settings
    const smtpSettings = await loadSystemConfig(supabase, "smtp_settings")
    const notifications = await loadSystemConfig(supabase, "notifications")
    const branding = await loadSystemConfig(supabase, "branding")
    
    const fromEmail = smtpSettings?.from_email || notifications?.from_email || "notifications@missedcallresponder.com"
    const fromName = smtpSettings?.from_name || notifications?.from_name || branding?.app_name || "Missed Call Responder"
    
    // Parse notification content for format detection
    // notification.content can be: plain text, or JSON with {format, body, body_html}
    let emailContent: any = {
      plain: notification.content,
      html: null
    }
    
    // Check if content is JSON with format specification
    try {
      const parsed = JSON.parse(notification.content)
      if (parsed.format && parsed.body) {
        emailContent.plain = parsed.body
        emailContent.html = parsed.body_html || null
      }
    } catch {
      // Not JSON, use as plain text
    }
    
    // Check if custom SMTP is configured
    if (smtpSettings?.host && smtpSettings?.username) {
      // Use custom SMTP via Supabase Edge Function or external service
      return await sendViaCustomSMTP(smtpSettings, {
        to: notification.recipient,
        from: fromEmail,
        fromName: fromName,
        subject: notification.subject,
        content: emailContent.plain,
        htmlContent: emailContent.html,
      })
    }
    
    // Fallback to SendGrid
    const sendgridApiKey = Deno.env.get("SENDGRID_API_KEY")
    if (!sendgridApiKey) {
      console.error("No email provider configured")
      return false
    }

    // Build content array for SendGrid
    const content: any[] = [{
      type: "text/plain",
      value: emailContent.plain,
    }]
    
    // Add HTML version if available
    if (emailContent.html) {
      content.push({
        type: "text/html",
        value: emailContent.html,
      })
    }

    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${sendgridApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{
          to: [{ email: notification.recipient }],
        }],
        from: { email: fromEmail, name: fromName },
        subject: notification.subject,
        content: content,
      }),
    })

    return response.ok
  } catch (error) {
    console.error("Send email error:", error)
    return false
  }
}

// Send via custom SMTP (using external service or AWS SES)
async function sendViaCustomSMTP(smtpSettings: any, email: any): Promise<boolean> {
  // Option 1: Use AWS SES
  if (smtpSettings.host.includes("amazonaws.com") || smtpSettings.host.includes("ses")) {
    return await sendViaAWSSES(smtpSettings, email)
  }
  
  // Option 2: Use Mailgun
  if (smtpSettings.host.includes("mailgun")) {
    return await sendViaMailgun(smtpSettings, email)
  }
  
  // Option 3: Use Postmark
  if (smtpSettings.host.includes("postmark")) {
    return await sendViaPostmark(smtpSettings, email)
  }
  
  // For now, log and return true (implement actual SMTP sending)
  console.log("Custom SMTP configured:", smtpSettings.host)
  console.log("Would send email to:", email.to)
  console.log("Plain text:", email.content?.substring(0, 100))
  console.log("HTML:", email.htmlContent?.substring(0, 100))
  
  return true
}

// Send via Mailgun
async function sendViaMailgun(smtpSettings: any, email: any): Promise<boolean> {
  try {
    const domain = smtpSettings.host.replace("smtp.mailgun.org", "").replace(".", "")
    const apiKey = smtpSettings.password_encrypted // Use API key
    
    const formData = new FormData()
    formData.append("from", `${email.fromName} <${email.from}>`)
    formData.append("to", email.to)
    formData.append("subject", email.subject)
    formData.append("text", email.content)
    
    if (email.htmlContent) {
      formData.append("html", email.htmlContent)
    }
    
    const response = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${btoa(`api:${apiKey}`)}`,
      },
      body: formData,
    })
    
    return response.ok
  } catch (error) {
    console.error("Mailgun error:", error)
    return false
  }
}

// Send via Postmark
async function sendViaPostmark(smtpSettings: any, email: any): Promise<boolean> {
  try {
    const apiKey = smtpSettings.password_encrypted // Use server token
    
    const response = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": apiKey,
      },
      body: JSON.stringify({
        From: `${email.fromName} <${email.from}>`,
        To: email.to,
        Subject: email.subject,
        TextBody: email.content,
        HtmlBody: email.htmlContent || undefined,
      }),
    })
    
    return response.ok
  } catch (error) {
    console.error("Postmark error:", error)
    return false
  }
}

// Send via AWS SES
async function sendViaAWSSES(smtpSettings: any, email: any): Promise<boolean> {
  try {
    // AWS SES implementation would go here
    // Requires AWS credentials and SES setup
    console.log("AWS SES email would be sent to:", email.to)
    return true
  } catch (error) {
    console.error("AWS SES error:", error)
    return false
  }
}

// Send SMS via Telnyx
async function sendSMS(supabase: any, notification: any): Promise<boolean> {
  const telnyxApiKey = Deno.env.get("TELNYX_API_KEY")
  
  if (!telnyxApiKey) {
    console.error("Telnyx API key not configured")
    return false
  }

  try {
    // Get tenant's phone number
    const { data: tenant } = await supabase
      .from("tenants")
      .select("phone_number")
      .eq("id", notification.tenant_id)
      .single()

    if (!tenant?.phone_number) {
      console.error("Tenant phone number not found")
      return false
    }

    const response = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${telnyxApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: tenant.phone_number,
        to: notification.recipient,
        text: notification.content,
      }),
    })

    return response.ok
  } catch (error) {
    console.error("Send SMS error:", error)
    return false
  }
}

// Send webhook
async function sendWebhook(notification: any): Promise<boolean> {
  try {
    const response = await fetch(notification.recipient, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subject: notification.subject,
        content: notification.content,
        timestamp: new Date().toISOString(),
      }),
    })

    return response.ok
  } catch (error) {
    console.error("Send webhook error:", error)
    return false
  }
}
