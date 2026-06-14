import { Redis } from '@upstash/redis'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

// Cache wrapper with TTL
export async function getCached(key) {
  try {
    return await redis.get(`mcr:${key}`)
  } catch (err) {
    console.error('Redis get error:', err)
    return null
  }
}

export async function setCached(key, value, ttl = 3600) {
  try {
    return await redis.set(`mcr:${key}`, value, { ex: ttl })
  } catch (err) {
    console.error('Redis set error:', err)
    return null
  }
}

export async function deleteCached(key) {
  try {
    return await redis.del(`mcr:${key}`)
  } catch (err) {
    console.error('Redis del error:', err)
    return null
  }
}

// Session management
export async function getSession(sessionId) {
  return await getCached(`session:${sessionId}`)
}

export async function setSession(sessionId, data, ttl = 86400) {
  return await setCached(`session:${sessionId}`, data, ttl)
}

// Call data caching
export async function cacheCallData(callId, data, ttl = 300) {
  return await setCached(`call:${callId}`, data, ttl)
}

export async function getCachedCallData(callId) {
  return await getCached(`call:${callId}`)
}

// Business configuration caching
export async function cacheBusinessConfig(businessId, config, ttl = 600) {
  return await setCached(`business:${businessId}`, config, ttl)
}

export async function getCachedBusinessConfig(businessId) {
  return await getCached(`business:${businessId}`)
}

// AI response caching
export async function cacheAIResponse(hash, response, ttl = 3600) {
  return await setCached(`ai:${hash}`, response, ttl)
}

export async function getCachedAIResponse(hash) {
  return await getCached(`ai:${hash}`)
}

// Phone number lookup caching
export async function cachePhoneLookup(phone, data, ttl = 86400) {
  return await setCached(`phone:${phone}`, data, ttl)
}

export async function getCachedPhoneLookup(phone) {
  return await getCached(`phone:${phone}`)
}

// Rate limiting
export async function checkRateLimit(key, limit = 10, window = 60) {
  try {
    const current = await redis.incr(`mcr:ratelimit:${key}`)
    if (current === 1) {
      await redis.expire(`mcr:ratelimit:${key}`, window)
    }
    return {
      allowed: current <= limit,
      remaining: Math.max(0, limit - current),
      reset: window,
    }
  } catch (err) {
    console.error('Rate limit error:', err)
    return { allowed: true, remaining: 0, reset: 0 }
  }
}

// Clear cache by pattern
export async function clearCachePattern(pattern) {
  try {
    const keys = await redis.keys(`mcr:${pattern}`)
    if (keys.length > 0) {
      await redis.del(...keys)
    }
    return keys.length
  } catch (err) {
    console.error('Redis clear error:', err)
    return 0
  }
}

export default redis