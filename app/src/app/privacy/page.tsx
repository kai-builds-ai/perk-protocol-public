"use client";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background text-text-primary">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-2xl font-sans font-bold text-white mb-2">Privacy Policy</h1>
        <p className="text-sm text-text-tertiary mb-10">Last updated: March 29, 2026</p>

        <div className="space-y-8 text-sm font-sans text-text-secondary leading-relaxed">
          <section>
            <h2 className="text-white font-semibold text-base mb-3">1. Overview</h2>
            <p>
              Perk (&quot;perk.fund&quot;) is a decentralized protocol. We are committed to minimizing data collection. This policy explains what information is collected when you use the Interface and how it is handled.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">2. What We Collect</h2>
            <p className="mb-3">We collect minimal information necessary to operate the Interface:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong className="text-white">Wallet addresses:</strong> Your public wallet address is visible on-chain when you interact with the Protocol. We do not link wallet addresses to personal identities.</li>
              <li><strong className="text-white">Transaction data:</strong> All transactions are recorded on the Solana blockchain and are publicly visible. This is inherent to blockchain technology, not a choice we make.</li>
              <li><strong className="text-white">Usage analytics:</strong> We may collect anonymous usage data (page views, feature usage) to improve the Interface. This data is not linked to wallet addresses or personal identities.</li>
              <li><strong className="text-white">Local storage:</strong> The Interface stores preferences and cached data in your browser&apos;s local storage. This data never leaves your device.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">3. What We Don&apos;t Collect</h2>
            <ul className="list-disc pl-5 space-y-2">
              <li>We do not collect names, emails, phone numbers, or any personal identification information.</li>
              <li>We do not require account creation or registration.</li>
              <li>We do not use tracking cookies or cross-site tracking.</li>
              <li>We do not sell, rent, or share any data with third parties for marketing purposes.</li>
              <li>We do not store your private keys or seed phrases. Ever.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">4. Third-Party Services</h2>
            <p className="mb-3">The Interface may interact with third-party services:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong className="text-white">RPC providers:</strong> Blockchain data is fetched through RPC providers who may log IP addresses per their own privacy policies.</li>
              <li><strong className="text-white">Wallet providers:</strong> Your wallet extension (Phantom, Solflare, etc.) has its own privacy policy governing how it handles your data.</li>
              <li><strong className="text-white">Price feeds:</strong> Oracle data is sourced from third-party providers to ensure accurate pricing.</li>
              <li><strong className="text-white">Hosting:</strong> The Interface is hosted on Vercel. Vercel may collect standard web server logs (IP addresses, request metadata) per their privacy policy.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">5. Blockchain Transparency</h2>
            <p>
              Solana is a public blockchain. All transactions, positions, and interactions with the Protocol&apos;s smart contracts are permanently recorded and publicly visible. This is a fundamental property of blockchain technology. You should not use the Protocol if you are not comfortable with public transaction records.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">6. Data Security</h2>
            <p>
              We implement reasonable security measures to protect any data processed by the Interface. However, no system is perfectly secure. You are responsible for securing your own wallet, private keys, and devices.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">7. Your Rights</h2>
            <p>
              Since we collect minimal data and do not maintain user accounts, there is generally no personal data to access, correct, or delete. On-chain data cannot be modified or removed due to the immutable nature of blockchain technology.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">8. Children</h2>
            <p>
              The Protocol is not intended for use by anyone under the age of 18. We do not knowingly collect information from minors.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">9. Changes</h2>
            <p>
              We may update this policy from time to time. Changes take effect upon posting. Your continued use of the Interface constitutes acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">10. Contact</h2>
            <p>
              For privacy-related questions, reach out via our official channels at{" "}
              <a href="https://x.com/PERK_FUND" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">@PERK_FUND</a>.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
