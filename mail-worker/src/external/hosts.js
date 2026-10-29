// Keep the provider callback hostname independent from the optional public site.
// A custom site is limited to this mailbox domain, never a wildcard or a URL.
export function customWebsiteHost(env) {
  const value=env.EXTERNAL_CUSTOM_WEBSITE_HOST;
  return value && value===`mail.${env.ONECLICK_DOMAIN}` ? value : null;
}

export function externalHostAllowed(hostname,env) {
  return hostname===env.EXTERNAL_WEBSITE_HOST || hostname===customWebsiteHost(env);
}
