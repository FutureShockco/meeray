import cache from '../../cache.js';
import logger from '../../logger.js';
import { adjustUserBalance } from '../../utils/account.js';
import { toBigInt } from '../../utils/bigint.js';
import { LaunchpadStatus } from './launchpad-interfaces.js';

export interface LaunchpadRefundPresaleData {
    launchpadId: string;
}

export async function validateTx(data: LaunchpadRefundPresaleData, sender: string): Promise<boolean> {
    try {
        // Only launchpad owner may request refunds
        const lp = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
        if (!lp) return false;
        if (lp.issuer !== sender) return false;
        if (!lp.presale || !lp.presaleDetailsSnapshot) return false;
        // Only if failed or cancelled before TGE
        if (lp.status !== LaunchpadStatus.PRESALE_FAILED_SOFTCAP_NOT_MET && lp.status !== LaunchpadStatus.CANCELLED) return false;
        return true;
    } catch (e) {
        logger.error('[launchpad-refund-presale] validate error', e);
        return false;
    }
}

export async function processTx(data: LaunchpadRefundPresaleData, _sender: string): Promise<boolean> {
    try {
        const lp = await cache.findOnePromise('launchpads', { _id: data.launchpadId });
        if (!lp || !lp.presale || !lp.presaleDetailsSnapshot) return false;
        const quoteId = lp.presaleDetailsSnapshot.quoteAssetForPresaleSymbol;

        const participants = lp.presale.participants || [];
        for (const p of participants) {
            const amt = toBigInt(p.quoteAmountContributed || '0');
            if (amt > toBigInt(0)) {
                const ok = await adjustUserBalance(p.userId, quoteId, amt);
                if (!ok) {
                    logger.error(`[launchpad-refund-presale] Failed refund for ${p.userId}`);
                    return false;
                }
            }
        }

        const ok = await cache.updateOnePromise(
            'launchpads',
            { _id: data.launchpadId },
            {
                $set: { updatedAt: new Date().toISOString() },
            }
        );
        return !!ok;
    } catch (e) {
        logger.error('[launchpad-refund-presale] process error', e);
        return false;
    }
}
