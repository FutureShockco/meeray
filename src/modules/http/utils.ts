import { Request } from 'express';

/**
 * @apiDefine PaginationParams
 * @apiParam {Number} [limit=10] Number of items to return per page (max: 100)
 * @apiParam {Number} [offset=0] Number of items to skip (for pagination)
 *
 * @apiParamExample {json} Pagination Example:
 *     {
 *       "limit": 20,
 *       "offset": 40
 *     }
 *
 * @apiSuccess {Object[]} data Array of items
 * @apiSuccess {Number} total Total number of items available
 * @apiSuccess {Number} limit Number of items per page
 * @apiSuccess {Number} skip Number of items skipped
 * @apiSuccess {Number} page Current page number
 *
 * @apiSuccessExample {json} Pagination Response:
 *     {
 *       "data": [...],
 *       "total": 150,
 *       "limit": 20,
 *       "skip": 40,
 *       "page": 3
 *     }
 */

/**
 * Get pagination parameters from request query
 * @param req Express request object
 * @returns Object with limit, skip, and page properties
 */
export const getPagination = (req: Request) => {
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = parseInt(req.query.offset as string) || 0;
    return {
        limit,
        skip: offset,
        page: Math.floor(offset / limit) + 1,
    };
};
