import cache from '../../cache.js';
import logger from '../../logger.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { LaunchpadStatus } from './launchpad-interfaces.js';

export interface LaunchpadFinalizePresaleData {
    launchpadId: string;
}

export async function validateTx(data: LaunchpadFinalizePresaleData, sender: string): Promise<boolean> {
    try {
        // Only launchpad owner may finalize presale; validate against launchpad owner
        const lp = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
        if (!lp) return false;
        if (lp.issuer !== sender) return false;
        if (!lp.presale || !lp.presaleDetailsSnapshot) return false;
        // Must be ended
        if (lp.status !== LaunchpadStatus.PRESALE_ENDED) return false;
        return true;
    } catch (e) {
        logger.error('[launchpad-finalize-presale] validate error', e);
        return false;
    }
}

export async function processTx(data: LaunchpadFinalizePresaleData, _sender: string): Promise<boolean> {
    try {
        const lp = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
        if (!lp || !lp.presale || !lp.presaleDetailsSnapshot) return false;

        const price = toBigInt(lp.presaleDetailsSnapshot.pricePerToken);
        const tokenDecimals = toBigInt(lp.tokenomicsSnapshot.tokenDecimals || 0);
        const scale = toBigInt(10) ** tokenDecimals;

        const participants = lp.presale.participants || [];
        const updated = participants.map((p: any) => {
            const contrib = toBigInt(p.quoteAmountContributed || '0');
            // tokensAllocated = floor(contrib * scale / price)
            const alloc = price > toBigInt(0) ? (contrib * scale) / price : toBigInt(0);
            return { ...p, tokensAllocated: toDbString(alloc) };
        });

        const nextStatus =
            toBigInt(lp.presale.totalQuoteRaised || '0') >= toBigInt(lp.presaleDetailsSnapshot.softCap || '0')
                ? LaunchpadStatus.PRESALE_SUCCEEDED_SOFTCAP_MET
                : LaunchpadStatus.PRESALE_FAILED_SOFTCAP_NOT_MET;

        const ok = await cache.updateOnePromise(
            'launchpads',
            { _id: data.launchpadId },
            {
                $set: {
                    'presale.participants': updated,
                    status: nextStatus,
                    updatedAt: new Date().toISOString(),
                },
            }
        );
        return !!ok;
    } catch (e) {
        logger.error('[launchpad-finalize-presale] process error', e);
        return false;
    }
}
