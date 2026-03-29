"use client";

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-background text-text-primary">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-2xl font-sans font-bold text-white mb-2">Terms of Service</h1>
        <p className="text-sm text-text-tertiary mb-10">Last updated: March 29, 2026</p>

        <div className="space-y-8 text-sm font-sans text-text-secondary leading-relaxed">
          <section>
            <h2 className="text-white font-semibold text-base mb-3">1. Acceptance</h2>
            <p>
              By accessing or using Perk (&quot;perk.fund&quot;, the &quot;Protocol&quot;, or the &quot;Interface&quot;), you agree to be bound by these Terms of Service. If you do not agree, do not use the Protocol. Your continued use constitutes acceptance of any updates to these terms.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">2. What Perk Is</h2>
            <p>
              Perk is a decentralized, permissionless perpetual futures protocol built on the Solana blockchain. The Interface provides a way to interact with on-chain smart contracts. Perk does not custody funds, execute trades on your behalf, or act as a counterparty. All transactions are peer-to-protocol and settled on-chain.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">3. Eligibility</h2>
            <p>
              You must be of legal age in your jurisdiction to use the Protocol. You are solely responsible for ensuring that your use of Perk complies with all applicable laws and regulations in your jurisdiction. Perk is not available to persons or entities subject to U.S. sanctions or located in jurisdictions where perpetual futures trading is prohibited.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">4. No Financial Advice</h2>
            <p>
              Nothing on the Interface constitutes financial, investment, legal, or tax advice. Perpetual futures are complex derivatives that carry significant risk of loss. You should consult qualified professionals before trading. Past performance does not indicate future results.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">5. Risks</h2>
            <p className="mb-3">By using Perk, you acknowledge and accept the following risks:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong className="text-white">Smart contract risk:</strong> The Protocol&apos;s smart contracts may contain bugs or vulnerabilities despite auditing and testing. Funds deposited into the Protocol could be permanently lost.</li>
              <li><strong className="text-white">Liquidation risk:</strong> Leveraged positions can be liquidated if the mark price moves against you. Liquidation may result in total loss of deposited collateral.</li>
              <li><strong className="text-white">Oracle risk:</strong> The Protocol relies on price oracles. Oracle failures, delays, or manipulation could result in incorrect pricing and unexpected liquidations or losses.</li>
              <li><strong className="text-white">Market risk:</strong> Cryptocurrency markets are highly volatile. Prices can move rapidly and unpredictably.</li>
              <li><strong className="text-white">Blockchain risk:</strong> Solana network congestion, outages, or forks may prevent timely execution of transactions.</li>
              <li><strong className="text-white">Regulatory risk:</strong> The regulatory landscape for DeFi and derivatives is evolving. Future regulations may impact your ability to use the Protocol.</li>
              <li><strong className="text-white">Permissionless markets:</strong> Anyone can create a market on Perk. The existence of a market does not imply endorsement, vetting, or due diligence of the underlying token.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">6. No Warranties</h2>
            <p>
              The Protocol and Interface are provided &quot;as is&quot; and &quot;as available&quot; without warranties of any kind, express or implied. We do not guarantee uptime, accuracy, completeness, or fitness for any particular purpose. We make no representations about the value or safety of any tokens traded on the Protocol.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">7. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by law, Perk, its contributors, developers, and affiliates shall not be liable for any direct, indirect, incidental, consequential, or punitive damages arising from your use of the Protocol. This includes, without limitation, loss of funds, loss of profits, trading losses, liquidation losses, and damages from smart contract exploits.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">8. Your Responsibilities</h2>
            <ul className="list-disc pl-5 space-y-2">
              <li>You are responsible for securing your wallet and private keys.</li>
              <li>You are responsible for all transactions made from your wallet.</li>
              <li>You will not use the Protocol for any unlawful purpose.</li>
              <li>You will not attempt to exploit, manipulate, or attack the Protocol or its oracles.</li>
              <li>You understand that transactions on the blockchain are irreversible.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">9. Fees</h2>
            <p>
              The Protocol charges trading fees as defined by on-chain parameters. Fee rates are visible before each transaction. Market creators receive a share of fees generated by their markets. Fees are non-refundable once a transaction is confirmed on-chain.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">10. Modifications</h2>
            <p>
              We reserve the right to modify these terms at any time. Changes take effect upon posting. Your continued use after changes constitutes acceptance.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">11. Governing Law</h2>
            <p>
              These terms shall be governed by and construed in accordance with applicable law, without regard to conflict of law principles. Any disputes arising from the use of the Protocol shall be resolved through binding arbitration.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">12. Severability</h2>
            <p>
              If any provision of these terms is found to be unenforceable, the remaining provisions shall continue in full force and effect.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">13. Contact</h2>
            <p>
              For questions about these terms, reach out via our official channels at{" "}
              <a href="https://x.com/PERK_FUND" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">@PERK_FUND</a>.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
