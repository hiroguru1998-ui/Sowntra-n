import { Router } from 'express';
import { 
  sendInvitation, 
  acceptInvitation, 
  getBoardInvitations,
  validateInvitation
} from '../controllers/invitation.controller';
import { authenticateUser, optionalAuth } from '../middleware/auth';

const router = Router();

// Validate invitation token (public - no auth required)
router.get('/validate/:token', validateInvitation);

// Send invitation
router.post('/send', authenticateUser, sendInvitation);

// Accept invitation (requires auth)
router.get('/accept/:token', authenticateUser, acceptInvitation);

// Get board invitations
router.get('/board/:boardId', authenticateUser, getBoardInvitations);

export default router;

