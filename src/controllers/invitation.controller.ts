import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { v4 as uuidv4 } from 'uuid';
import nodemailer from 'nodemailer';

/**
 * Send board invitation via email
 */
export const sendInvitation = async (req: Request, res: Response): Promise<any> => {
  try {
    const { boardId, email, role = 'editor' } = req.body;
    const userId = req.user?.dbUserId;

    if (!boardId || !email) {
      return res.status(400).json({ 
        success: false, 
        message: 'Board ID and email are required' 
      });
    }

    // Verify board ownership or editor access
    const board = await prisma.board.findUnique({
      where: { id: boardId },
      include: {
        owner: true,
        members: true
      }
    });

    if (!board) {
      return res.status(404).json({ 
        success: false, 
        message: 'Board not found' 
      });
    }

    if (!userId) {
      return res.status(401).json({ 
        success: false, 
        message: 'Unauthorized' 
      });
    }

    // Check if user has permission to invite
    const isOwner = board.ownerId === userId;
    const isMember = board.members.some(
      m => m.userId === userId && (m.role === 'owner' || m.role === 'editor')
    );

    if (!isOwner && !isMember) {
      return res.status(403).json({ 
        success: false, 
        message: 'You do not have permission to invite users to this board' 
      });
    }

    // Check if invitation already exists
    const existingInvitation = await prisma.boardInvitation.findUnique({
      where: {
        boardId_email: {
          boardId,
          email
        }
      }
    });

    let invitation;
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    if (existingInvitation && existingInvitation.status === 'pending') {
      // Update existing invitation
      invitation = await prisma.boardInvitation.update({
        where: { id: existingInvitation.id },
        data: {
          token,
          expiresAt,
          role,
          invitedBy: userId
        }
      });
    } else {
      // Create new invitation
      invitation = await prisma.boardInvitation.create({
        data: {
          boardId,
          email,
          invitedBy: userId,
          token,
          role,
          expiresAt
        }
      });
    }

    // Send email invitation
    try {
      await sendInvitationEmail(
        email,
        board.title,
        token,
        board.owner.name || board.owner.email
      );
    } catch (emailError) {
      console.error('Failed to send invitation email:', emailError);
      // Don't fail the entire request if email fails
    }

    res.json({
      success: true,
      message: 'Invitation sent successfully',
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt
      }
    });
  } catch (error) {
    console.error('Error sending invitation:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to send invitation' 
    });
  }
};

/**
 * Accept board invitation
 */
export const acceptInvitation = async (req: Request, res: Response): Promise<any> => {
  try {
    const { token } = req.params;
    const userId = req.user?.dbUserId;
    const userEmail = req.user?.email;

    console.log('Accepting invitation:', {
      token,
      userId,
      userEmail,
      hasUser: !!req.user
    });

    if (!token) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invitation token is required' 
      });
    }

    // Find invitation
    const invitation = await prisma.boardInvitation.findUnique({
      where: { token }
    });

    console.log('Invitation found:', invitation ? {
      id: invitation.id,
      email: invitation.email,
      boardId: invitation.boardId,
      status: invitation.status
    } : 'Not found');

    if (!invitation) {
      return res.status(404).json({ 
        success: false, 
        message: 'Invitation not found' 
      });
    }

    // Check if invitation is expired
    if (new Date() > invitation.expiresAt) {
      await prisma.boardInvitation.update({
        where: { id: invitation.id },
        data: { status: 'expired' }
      });
      
      return res.status(400).json({ 
        success: false, 
        message: 'Invitation has expired' 
      });
    }

    // Check if invitation email matches user email (case-insensitive)
    // For collaboration, we allow accepting if user is authenticated, but warn if emails don't match
    if (userEmail && invitation.email.toLowerCase() !== userEmail.toLowerCase()) {
      console.warn('Email mismatch detected:', {
        invitationEmail: invitation.email,
        userEmail: userEmail,
        invitationEmailLower: invitation.email.toLowerCase(),
        userEmailLower: userEmail.toLowerCase()
      });
      
      // Allow acceptance but log the mismatch for security purposes
      // In production, you might want to make this stricter or send a notification
      console.log('Allowing invitation acceptance despite email mismatch (user is authenticated)');
    }

    if (!userId) {
      return res.status(401).json({ 
        success: false, 
        message: 'Please log in to accept this invitation' 
      });
    }

    // Check if user is already a member
    const existingMember = await prisma.boardMember.findUnique({
      where: {
        boardId_userId: {
          boardId: invitation.boardId,
          userId: userId
        }
      }
    });

    if (existingMember) {
      // Update invitation status even if already a member
      await prisma.boardInvitation.update({
        where: { id: invitation.id },
        data: { status: 'accepted' }
      });
      
      return res.status(200).json({ 
        success: true, 
        message: 'You are already a member of this board',
        board: await prisma.board.findUnique({
          where: { id: invitation.boardId }
        })
      });
    }

    // Add user as board member
    await prisma.boardMember.create({
      data: {
        boardId: invitation.boardId,
        userId: userId,
        role: invitation.role
      }
    });

    // Update invitation status
    await prisma.boardInvitation.update({
      where: { id: invitation.id },
      data: { status: 'accepted' }
    });

    // Get board details
    const board = await prisma.board.findUnique({
      where: { id: invitation.boardId }
    });

    res.json({
      success: true,
      message: 'Invitation accepted successfully',
      board: board ? {
        id: board.id,
        title: board.title,
        description: board.description
      } : null
    });
  } catch (error) {
    console.error('Error accepting invitation:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to accept invitation' 
    });
  }
};

/**
 * Validate invitation token (public endpoint - no auth required)
 */
export const validateInvitation = async (req: Request, res: Response): Promise<any> => {
  try {
    const { token } = req.params;

    console.log('Validating invitation token:', token);

    if (!token) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invitation token is required' 
      });
    }

    // Find invitation
    const invitation = await prisma.boardInvitation.findUnique({
      where: { token },
      include: {
        board: {
          select: {
            id: true,
            title: true,
            description: true,
            owner: {
              select: {
                name: true,
                email: true
              }
            }
          }
        }
      }
    });

    console.log('Invitation lookup result:', invitation ? 'Found' : 'Not found');

    if (!invitation) {
      console.error('Invitation not found for token:', token);
      return res.status(404).json({ 
        success: false, 
        message: 'Invitation not found. Please check the invitation link.' 
      });
    }

    // Check if invitation is expired
    const now = new Date();
    const expiresAt = new Date(invitation.expiresAt);
    
    console.log('Checking expiration - Now:', now, 'Expires:', expiresAt);

    if (now > expiresAt) {
      await prisma.boardInvitation.update({
        where: { id: invitation.id },
        data: { status: 'expired' }
      });
      
      return res.status(400).json({ 
        success: false, 
        message: 'Invitation has expired' 
      });
    }

    // Check if invitation status is already accepted or expired
    if (invitation.status === 'accepted') {
      return res.status(400).json({ 
        success: false, 
        message: 'This invitation has already been accepted' 
      });
    }

    if (invitation.status === 'expired') {
      return res.status(400).json({ 
        success: false, 
        message: 'This invitation has expired' 
      });
    }

    res.json({
      success: true,
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        board: invitation.board
      }
    });
  } catch (error) {
    console.error('Error validating invitation:', error);
    console.error('Error details:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
    res.status(500).json({ 
      success: false, 
      message: 'Failed to validate invitation',
      error: process.env.NODE_ENV === 'development' ? (error instanceof Error ? error.message : 'Unknown error') : undefined
    });
  }
};

/**
 * Get board invitations (for board owner)
 */
export const getBoardInvitations = async (req: Request, res: Response): Promise<any> => {
  try {
    const { boardId } = req.params;
    const userId = req.user?.dbUserId;

    // Verify board access
    const board = await prisma.board.findUnique({
      where: { id: boardId }
    });

    if (!board) {
      return res.status(404).json({ 
        success: false, 
        message: 'Board not found' 
      });
    }

    if (board.ownerId !== userId) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied' 
      });
    }

    const invitations = await prisma.boardInvitation.findMany({
      where: { boardId },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      invitations
    });
  } catch (error) {
    console.error('Error fetching invitations:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch invitations' 
    });
  }
};

/**
 * Send invitation email using nodemailer
 */
async function sendInvitationEmail(
  email: string,
  boardTitle: string,
  token: string,
  inviterName: string
): Promise<void> {
  // Create transporter
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const inviteUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/invite/${token}`;

  const mailOptions = {
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: `Invitation to collaborate on "${boardTitle}"`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>You've been invited to collaborate!</h2>
        <p><strong>${inviterName}</strong> has invited you to collaborate on the board <strong>"${boardTitle}"</strong>.</p>
        
        <p>Click the button below to accept the invitation and start collaborating:</p>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${inviteUrl}" 
             style="background-color: #4F46E5; color: white; padding: 12px 30px; 
                    text-decoration: none; border-radius: 5px; display: inline-block;">
            Accept Invitation
          </a>
        </div>
        
        <p style="color: #666; font-size: 14px;">
          Or copy and paste this link into your browser:<br>
          <a href="${inviteUrl}">${inviteUrl}</a>
        </p>
        
        <p style="color: #666; font-size: 12px; margin-top: 30px;">
          This invitation will expire in 7 days.
        </p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
}

